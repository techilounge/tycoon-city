import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import type { GameCommand } from '../../src/lib/game/commands';
import { applyCommand, createGame } from '../../src/lib/game/engine/reducer';
import { rngForState } from '../../src/lib/game/rng';
import { buildSnapshot } from '../../src/lib/game/snapshot-schema';
import { TycoonDb } from '../../server/db';

const SEED = 0x5eed1234;
const PLAYERS = ['p1', 'p2', 'p3'];

function tmpDbPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-db-')), 'test.db');
}

function startCommand(version: number, commandId: string): GameCommand {
  return { type: 'START_GAME', gameId: 'g-db-1', actorId: 'p1', commandId, expectedVersion: version, payload: {} };
}

describe('TycoonDb round-trips', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDbPath();
  });

  it('persists a new game and reads it back by id and by room code', () => {
    const db = TycoonDb.open(dbPath);
    try {
      const created = createGame({ gameId: 'g-db-1', seed: SEED, playerIds: PLAYERS });
      assert.ok(created.ok);
      if (!created.ok) return;
      const roomCode = db.newRoomCode();
      db.persistNewGame({ gameId: 'g-db-1', roomCode, mode: 'CLASSIC', snapshot: buildSnapshot(created.state), events: created.events });

      const byId = db.getGame('g-db-1');
      assert.ok(byId);
      assert.equal(byId.phase, 'LOBBY');
      assert.equal(byId.mode, 'CLASSIC');
      assert.equal(byId.roomCode, roomCode);

      const byCode = db.getGameByRoomCode(roomCode);
      assert.ok(byCode);
      assert.equal(byCode.gameId, 'g-db-1');
      assert.equal(db.getGameByRoomCode('ZZZZZZ'), null);
    } finally {
      db.close();
    }
  });

  it('mints 6-char room codes from the unambiguous alphabet', () => {
    const db = TycoonDb.open(dbPath);
    try {
      for (let i = 0; i < 50; i++) {
        const code = db.newRoomCode();
        assert.match(code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
      }
    } finally {
      db.close();
    }
  });

  it('round-trips an applied command: events, stored-events ledger, and snapshot', () => {
    const db = TycoonDb.open(dbPath);
    try {
      const created = createGame({ gameId: 'g-db-1', seed: SEED, playerIds: PLAYERS });
      assert.ok(created.ok);
      if (!created.ok) return;
      db.persistNewGame({
        gameId: 'g-db-1',
        roomCode: db.newRoomCode(),
        mode: 'CLASSIC',
        snapshot: buildSnapshot(created.state),
        events: created.events,
      });

      // Apply START_GAME exactly the way the GameHost does.
      const rng = rngForState(created.state.rngState);
      const result = applyCommand(created.state, startCommand(created.state.version, 'c-start-1'), rng);
      assert.ok(result.ok);
      if (!result.ok) return;

      db.recordApplied({
        gameId: 'g-db-1',
        commandId: 'c-start-1',
        actorId: 'p1',
        commandType: 'START_GAME',
        events: result.events,
        snapshot: buildSnapshot(result.state),
      });

      // Ledger: the stored events of the original application.
      const stored = db.getStoredEvents('g-db-1', 'c-start-1');
      assert.ok(stored);
      assert.equal(stored.length, result.events.length);
      assert.deepEqual(
        stored.map((e) => e.sequence),
        result.events.map((e) => e.sequence),
      );
      assert.equal(db.getStoredEvents('g-db-1', 'c-other'), null);

      // Event log: GAME_CREATED then START_GAME events, gapless by sequence.
      const all = db.getEvents('g-db-1', 1);
      assert.ok(all.length >= 2);
      assert.equal(all[0].type, 'GAME_CREATED');
      assert.ok(all.some((e) => e.type === 'TURN_STARTED'));
      for (let i = 1; i < all.length; i++) assert.equal(all[i].sequence, all[i - 1].sequence + 1);

      // Snapshot: latest state with a consistent header.
      const snapshot = db.loadSnapshot('g-db-1');
      assert.ok(snapshot);
      assert.equal(snapshot.stateVersion, result.state.version);
      assert.equal(snapshot.state.phase, 'PLAYING');
      assert.equal(snapshot.gameId, 'g-db-1');
      assert.equal(snapshot.seed, SEED);
    } finally {
      db.close();
    }
  });

  it('survives a restart: reopen the same file and read identical state and ledger', () => {
    // First open: create and apply.
    const db1 = TycoonDb.open(dbPath);
    const created = createGame({ gameId: 'g-db-1', seed: SEED, playerIds: PLAYERS });
    assert.ok(created.ok);
    if (!created.ok) return;
    db1.persistNewGame({
      gameId: 'g-db-1',
      roomCode: db1.newRoomCode(),
      mode: 'CLASSIC',
      snapshot: buildSnapshot(created.state),
      events: created.events,
    });
    const applied = applyCommand(created.state, startCommand(created.state.version, 'c-start-1'), rngForState(created.state.rngState));
    assert.ok(applied.ok);
    if (!applied.ok) return;
    db1.recordApplied({
      gameId: 'g-db-1',
      commandId: 'c-start-1',
      actorId: 'p1',
      commandType: 'START_GAME',
      events: applied.events,
      snapshot: buildSnapshot(applied.state),
    });
    db1.close();

    // Second open over the same file: everything the socket path needs.
    const db2 = TycoonDb.open(dbPath);
    try {
      const snapshot = db2.loadSnapshot('g-db-1');
      assert.ok(snapshot);
      assert.equal(snapshot.state.version, applied.state.version);
      assert.equal(snapshot.state.phase, 'PLAYING');
      const stored = db2.getStoredEvents('g-db-1', 'c-start-1');
      assert.ok(stored);
      assert.equal(stored.length, applied.events.length);
      const game = db2.getGame('g-db-1');
      assert.ok(game);
      assert.equal(game.phase, 'PLAYING');
    } finally {
      db2.close();
    }
  });

  it('refuses a corrupt stored snapshot loudly instead of loading it', () => {
    const db = TycoonDb.open(dbPath);
    const created = createGame({ gameId: 'g-db-1', seed: SEED, playerIds: PLAYERS });
    assert.ok(created.ok);
    if (!created.ok) return;
    db.persistNewGame({
      gameId: 'g-db-1',
      roomCode: db.newRoomCode(),
      mode: 'CLASSIC',
      snapshot: buildSnapshot(created.state),
      events: created.events,
    });
    db.close();

    // Corrupt the stored snapshot out-of-band (simulates a bad write / version drift).
    const raw = new Database(dbPath);
    raw.prepare('UPDATE games SET state_snapshot = ? WHERE game_id = ?').run('{"schemaVersion":99}', 'g-db-1');
    raw.close();

    const db2 = TycoonDb.open(dbPath);
    try {
      assert.throws(() => db2.loadSnapshot('g-db-1'), /refused/);
    } finally {
      db2.close();
    }
  });

  it('creates, reads, expires, and touches sessions', () => {
    const db = TycoonDb.open(dbPath);
    try {
      const session = db.createSession({ gameId: 'g-db-1', actorId: 'p1', name: 'Alice', ttlMs: 60_000 });
      assert.equal(session.gameId, 'g-db-1');
      assert.equal(session.actorId, 'p1');
      assert.match(session.token, /^[0-9a-f]{64}$/);

      const read = db.getSession(session.token);
      assert.ok(read);
      assert.equal(read.actorId, 'p1');
      assert.equal(db.getSession('nope'), null);

      // An expired token is not a session.
      const expired = db.createSession({ gameId: 'g-db-1', actorId: 'p2', name: 'Bob', ttlMs: -1 });
      assert.equal(db.getSession(expired.token), null);

      // Touching a live session keeps it live.
      db.touchSession(session.token);
      assert.ok(db.getSession(session.token));
    } finally {
      db.close();
    }
  });
});
