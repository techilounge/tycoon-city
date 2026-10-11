/**
 * SQLite persistence for the authoritative server (spec decision 2): games,
 * the durable event log, the stored-events command ledger, and guest
 * sessions — one zero-ops file database. better-sqlite3's synchronous API
 * matches the engine's synchronous reducer, so every applied command commits
 * its events, ledger row, and snapshot in exactly one transaction
 * (spec "Durability shape"), and a restart reloads the latest snapshot.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { AnyGameEvent } from '../src/lib/game/events';
import { validateEventEnvelope } from '../src/lib/game/events';
import type { GameCommand } from '../src/lib/game/commands';
import { parseSnapshot, serializeSnapshot, type GameSnapshot } from '../src/lib/game/snapshot-schema';
import type { ModeId } from '../src/lib/game/board-v1';
import type { GamePhase } from '../src/lib/game/types';
import { SESSION_TTL_MS, mintSessionToken } from './sessions';

export const DEFAULT_DB_PATH = './data/tycoon.db';

/** 6-character room codes from an unambiguous alphabet — no 0/O/1/I (spec decision 4). */
/** Unambiguous room-code alphabet — no 0/O/1/I. Exported for test byte-source round-trips. */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const ROOM_CODE_LENGTH = 6;
const ROOM_CODE_ATTEMPTS = 16;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS games (
  game_id TEXT PRIMARY KEY,
  room_code TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL,
  phase TEXT NOT NULL,
  state_snapshot TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  game_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  command_id TEXT,
  event TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (game_id, sequence)
);
CREATE TABLE IF NOT EXISTS commands (
  game_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  type TEXT NOT NULL,
  events TEXT NOT NULL,
  command_json TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (game_id, command_id)
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  game_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_game ON sessions(game_id);
`;

export interface GameRow {
  readonly gameId: string;
  readonly roomCode: string;
  readonly mode: ModeId;
  readonly phase: GamePhase;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface SessionRow {
  readonly token: string;
  readonly gameId: string;
  readonly actorId: string;
  readonly name: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly lastSeenAt: number;
}

export interface PersistNewGameInput {
  readonly gameId: string;
  readonly roomCode: string;
  readonly mode: ModeId;
  /** The schema-stamped snapshot of the freshly created LOBBY state. */
  readonly snapshot: GameSnapshot;
  /** The creation ledger — GAME_CREATED stamped at sequence 1. */
  readonly events: readonly AnyGameEvent[];
}

export interface RecordAppliedInput {
  readonly gameId: string;
  readonly commandId: string;
  readonly actorId: string;
  readonly commandType: string;
  /** The full applied command — the audit/replay input (spec: replay is the audit tool). */
  readonly command: GameCommand;
  readonly events: readonly AnyGameEvent[];
  readonly snapshot: GameSnapshot;
}

interface GamesRowSql {
  readonly game_id: string;
  readonly room_code: string;
  readonly mode: string;
  readonly phase: string;
  readonly created_at: number;
  readonly updated_at: number;
}

interface SessionsRowSql {
  readonly token: string;
  readonly game_id: string;
  readonly actor_id: string;
  readonly name: string;
  readonly created_at: number;
  readonly expires_at: number;
  readonly last_seen_at: number;
}

export class TycoonDb {
  private readonly db: Database.Database;

  private constructor(db: Database.Database) {
    this.db = db;
  }

  static open(dbPath: string = DEFAULT_DB_PATH): TycoonDb {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    // Migration: command_json was added after the first dev databases were
    // created; ALTER TABLE covers old files (new rows always carry the payload).
    const commandColumns = (db.pragma('table_info(commands)') as Array<{ name: string }>).map((c) => c.name);
    if (commandColumns.length > 0 && !commandColumns.includes('command_json')) {
      db.exec('ALTER TABLE commands ADD COLUMN command_json TEXT');
    }
    db.exec(SCHEMA);
    return new TycoonDb(db);
  }

  close(): void {
    this.db.close();
  }

  /**
   * Mint a unique room code, backed by the UNIQUE constraint's collision
   * check. 31^6 ≈ 887M codes — the retry bound is unreachable in practice,
   * and throwing loudly beats silently weakening the alphabet. The byte
   * source is injectable so the collision-retry path is deterministically
   * testable.
   */
  newRoomCode(bytes: (length: number) => Buffer = randomBytes): string {
    for (let attempt = 0; attempt < ROOM_CODE_ATTEMPTS; attempt++) {
      const raw = bytes(ROOM_CODE_LENGTH);
      let code = '';
      for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
        code += ROOM_CODE_ALPHABET[raw[i] % ROOM_CODE_ALPHABET.length];
      }
      const taken = this.db.prepare('SELECT 1 FROM games WHERE room_code = ?').get(code);
      if (taken === undefined) return code;
    }
    throw new Error('room code space exhausted after retries');
  }

  /** Persist a freshly created game: its row and the GAME_CREATED event in one transaction. */
  persistNewGame(input: PersistNewGameInput): void {
    const now = Date.now();
    const write = this.db.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO games (game_id, room_code, mode, phase, state_snapshot, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          input.gameId,
          input.roomCode,
          input.mode,
          input.snapshot.state.phase,
          serializeSnapshot(input.snapshot),
          now,
          now,
        );
      this.insertEvents(input.gameId, input.events, now);
    });
    write();
  }

  getGame(gameId: string): GameRow | null {
    const row = this.db
      .prepare('SELECT game_id, room_code, mode, phase, created_at, updated_at FROM games WHERE game_id = ?')
      .get(gameId) as GamesRowSql | undefined;
    return row ? toGameRow(row) : null;
  }

  getGameByRoomCode(roomCode: string): GameRow | null {
    const row = this.db
      .prepare('SELECT game_id, room_code, mode, phase, created_at, updated_at FROM games WHERE room_code = ?')
      .get(roomCode) as GamesRowSql | undefined;
    return row ? toGameRow(row) : null;
  }

  /**
   * One transaction per applied command (spec "Durability shape"): the event
   * batch, the same batch keyed by commandId in the stored-events ledger, and
   * the fresh state snapshot — atomic, so a restart never sees a torn write.
   */
  recordApplied(input: RecordAppliedInput): void {
    const now = Date.now();
    const write = this.db.transaction(() => {
      this.insertEvents(input.gameId, input.events, now);
      this.db
        .prepare(
          'INSERT INTO commands (game_id, command_id, actor_id, type, events, command_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          input.gameId,
          input.commandId,
          input.actorId,
          input.commandType,
          JSON.stringify(input.events),
          JSON.stringify(input.command),
          now,
        );
      this.db
        .prepare('UPDATE games SET phase = ?, state_snapshot = ?, updated_at = ? WHERE game_id = ?')
        .run(input.snapshot.state.phase, serializeSnapshot(input.snapshot), now, input.gameId);
    });
    write();
  }

  /** The stored events of the original application — the §2.1 step-4 ledger read. */
  getStoredEvents(gameId: string, commandId: string): AnyGameEvent[] | null {
    const row = this.db
      .prepare('SELECT events FROM commands WHERE game_id = ? AND command_id = ?')
      .get(gameId, commandId) as { events: string } | undefined;
    return row ? this.parseEventBatch(row.events) : null;
  }

  /** Every applied command in application order — the replay/audit input (spec: replay is the audit tool). */
  listAppliedCommands(gameId: string): GameCommand[] {
    const rows = this.db
      .prepare('SELECT command_json FROM commands WHERE game_id = ? ORDER BY rowid')
      .all(gameId) as Array<{ command_json: string | null }>;
    return rows.map((row, index) => {
      if (row.command_json === null) {
        throw new Error(
          `game ${gameId} ledger row ${index + 1} has no command payload — created by an older build; delete the dev database to replay`,
        );
      }
      return JSON.parse(row.command_json) as GameCommand;
    });
  }

  /** All events of a game from `fromSeq` — the reconnection catch-up read (spec §3). */
  getEvents(gameId: string, fromSeq: number): AnyGameEvent[] {
    const rows = this.db
      .prepare('SELECT event FROM events WHERE game_id = ? AND sequence >= ? ORDER BY sequence')
      .all(gameId, fromSeq) as { event: string }[];
    return rows.map((row) => this.parseEventRow(row.event));
  }

  /**
   * Load and validate the latest state snapshot — the refusal gate applies
   * to the server too: unknown schema or rules versions throw loudly rather
   * than loading half-trusted state (seam map §3 obligation 1).
   */
  loadSnapshot(gameId: string): GameSnapshot | null {
    const row = this.db
      .prepare('SELECT state_snapshot FROM games WHERE game_id = ?')
      .get(gameId) as { state_snapshot: string } | undefined;
    if (row === undefined) return null;
    const parsed = parseSnapshot(row.state_snapshot);
    if (!parsed.ok) {
      throw new Error(`stored snapshot for game ${gameId} refused (${parsed.reason}): ${parsed.message}`);
    }
    return parsed.snapshot;
  }

  createSession(input: { gameId: string; actorId: string; name: string; ttlMs?: number }): SessionRow {
    const now = Date.now();
    const row: SessionsRowSql = {
      token: mintSessionToken(),
      game_id: input.gameId,
      actor_id: input.actorId,
      name: input.name,
      created_at: now,
      expires_at: now + (input.ttlMs ?? SESSION_TTL_MS),
      last_seen_at: now,
    };
    this.db
      .prepare(
        'INSERT INTO sessions (token, game_id, actor_id, name, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(row.token, row.game_id, row.actor_id, row.name, row.created_at, row.expires_at, row.last_seen_at);
    return toSessionRow(row);
  }

  /** The live session for a token, or null when unknown/expired. */
  getSession(token: string): SessionRow | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE token = ?').get(token) as SessionsRowSql | undefined;
    if (row === undefined) return null;
    if (row.expires_at <= Date.now()) return null;
    return toSessionRow(row);
  }

  touchSession(token: string): void {
    this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token = ?').run(Date.now(), token);
  }

  /**
   * Every session row for a game, INCLUDING expired ones: a seat claim is
   * permanent for the game's lifetime — an expired token loses authentication
   * (getSession), never its seat. Ordering is by rowid (claim order). */
  listSessionsForGame(gameId: string): SessionRow[] {
    const rows = this.db
      .prepare('SELECT * FROM sessions WHERE game_id = ? ORDER BY rowid')
      .all(gameId) as SessionsRowSql[];
    return rows.map(toSessionRow);
  }

  private insertEvents(gameId: string, events: readonly AnyGameEvent[], now: number): void {
    const insert = this.db.prepare(
      'INSERT INTO events (game_id, sequence, type, command_id, event, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const event of events) {
      insert.run(gameId, event.sequence, event.type, event.commandId, JSON.stringify(event), now);
    }
  }

  /** Read-back validation: a stored event that fails its envelope is corruption, surfaced loudly. */
  private parseEventRow(raw: string): AnyGameEvent {
    const event = JSON.parse(raw) as AnyGameEvent;
    const problem = validateEventEnvelope(event);
    if (problem) throw new Error(`stored event failed envelope validation: ${problem.code} ${problem.message}`);
    return event;
  }

  /** The commands-ledger row stores the full event batch of the original application. */
  private parseEventBatch(raw: string): AnyGameEvent[] {
    const events = JSON.parse(raw) as AnyGameEvent[];
    for (const event of events) {
      const problem = validateEventEnvelope(event);
      if (problem) throw new Error(`stored event failed envelope validation: ${problem.code} ${problem.message}`);
    }
    return events;
  }
}

function toGameRow(row: GamesRowSql): GameRow {
  return {
    gameId: row.game_id,
    roomCode: row.room_code,
    mode: row.mode as ModeId,
    phase: row.phase as GamePhase,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toSessionRow(row: SessionsRowSql): SessionRow {
  return {
    token: row.token,
    gameId: row.game_id,
    actorId: row.actor_id,
    name: row.name,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastSeenAt: row.last_seen_at,
  };
}
