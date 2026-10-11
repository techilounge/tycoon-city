/**
 * The authoritative per-game service (spec "Server core"): the ONLY state
 * transition is `applyCommand`, run verbatim inside a per-game queue. Every
 * applied command persists events + ledger + snapshot in one SQLite
 * transaction, then broadcasts the stamped events and the redacted state to
 * the game's room. Rejection purity holds over the wire: a rejected command
 * returns its typed error with the state hash untouched.
 *
 * Deliberately NOT here (Phase 2 PR 15): room lifecycle (create/join by
 * code), seat caps, and deadline enforcement — this class is the state core
 * they build on.
 */
import { randomBytes } from 'node:crypto';
import type { Server } from 'socket.io';
import type { GameCommand } from '../../src/lib/game/commands';
import type { AnyGameEvent } from '../../src/lib/game/events';
import { applyCommand, createGame } from '../../src/lib/game/engine/reducer';
import { rngForState } from '../../src/lib/game/rng';
import { buildSnapshot } from '../../src/lib/game/snapshot-schema';
import type { ModeId } from '../../src/lib/game/board-v1';
import type { GameState } from '../../src/lib/game/types';
import { gameRoomOf, toWireError, type WireCommandResult } from '../../src/lib/game/transport/protocol';
import type { TycoonDb } from '../db';
import { SubmitQueue } from './queue';
import { projectClientState } from './redact';

/** The authenticated identity a command runs as — minted server-side, never claimed. */
export interface SubmitSession {
  readonly gameId: string;
  readonly actorId: string;
}

export interface CreateHostGameInput {
  readonly mode: ModeId;
  readonly playerIds: readonly string[];
  /** Overrides for deterministic tests; production derives both from crypto randomness. */
  readonly gameId?: string;
  readonly seed?: number;
}

export class GameHost {
  private readonly queue = new SubmitQueue();
  private state: GameState;

  private constructor(
    private readonly db: TycoonDb,
    private readonly io: Server,
    state: GameState,
  ) {
    this.state = state;
  }

  /**
   * Create a game the way the local lobby does — through `createGame` — but
   * with the seed generated server-side from crypto randomness (spec
   * decision 5: the online flow never accepts a client seed).
   */
  static create(
    db: TycoonDb,
    io: Server,
    input: CreateHostGameInput,
  ): { host: GameHost; gameId: string; roomCode: string } {
    const gameId = input.gameId ?? `g-${randomBytes(8).toString('hex')}`;
    const seed = input.seed ?? randomBytes(4).readUInt32BE(0);
    const created = createGame({ gameId, seed, playerIds: [...input.playerIds], mode: input.mode });
    if (!created.ok) throw created.error;
    const roomCode = db.newRoomCode();
    db.persistNewGame({
      gameId,
      roomCode,
      mode: created.state.mode,
      snapshot: buildSnapshot(created.state),
      events: created.events,
    });
    return { host: new GameHost(db, io, created.state), gameId, roomCode };
  }

  /** Reload from the latest stored snapshot — the restart/resume path (spec criterion 9). */
  static resume(db: TycoonDb, io: Server, gameId: string): GameHost | null {
    const snapshot = db.loadSnapshot(gameId);
    if (snapshot === null) return null;
    return new GameHost(db, io, snapshot.state);
  }

  /**
   * Queue a command from an authenticated session. Identity is stamped here,
   * inside the serialization boundary: the session's binding wins and a
   * client-claimed actorId/gameId are ignored (spec criterion 4).
   */
  submit(session: SubmitSession, raw: unknown): Promise<WireCommandResult> {
    return this.queue.push(() => this.submitNow(session, raw));
  }

  private submitNow(session: SubmitSession, raw: unknown): WireCommandResult {
    // The client's claimed identity is dropped; shape is re-validated from
    // scratch by the pipeline's step 1 — this is untrusted wire input.
    const claimed = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<GameCommand>;
    const command = { ...claimed, gameId: session.gameId, actorId: session.actorId } as GameCommand;

    // Same reseeding contract as LocalCommandSink (transport.ts): the RNG
    // word rides in the state, the source is derived per command.
    const rng = rngForState(this.state.rngState);
    const result = applyCommand(this.state, command, rng);
    if (!result.ok) return { ok: false, error: toWireError(result.error) };

    if (!result.applied) {
      // Idempotent retry (§2.1 step 4): same state, the STORED events of the
      // original application — served from the ledger, so it also works
      // across a server restart. Shape validation has already proven
      // commandId is a non-empty string.
      const stored = this.db.getStoredEvents(session.gameId, command.commandId);
      return { ok: true, applied: false, events: stored ?? [] };
    }

    this.state = result.state;
    this.db.recordApplied({
      gameId: session.gameId,
      commandId: command.commandId,
      actorId: session.actorId,
      commandType: command.type,
      events: result.events,
      snapshot: buildSnapshot(result.state),
    });
    const room = gameRoomOf(this.state.gameId);
    for (const event of result.events as readonly AnyGameEvent[]) this.io.to(room).emit('game:event', event);
    this.io.to(room).emit('game:state', projectClientState(this.state));
    return { ok: true, applied: true, events: result.events };
  }
}
