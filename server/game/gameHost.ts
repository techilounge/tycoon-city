/**
 * The authoritative per-game service (spec "Server core"): the ONLY state
 * transition is `applyCommand`, run verbatim inside a per-game queue. Every
 * applied command persists events + ledger + snapshot in one SQLite
 * transaction, then broadcasts the stamped events and the redacted state to
 * the game's room. Rejection purity holds over the wire: a rejected command
 * returns its typed error with the state hash untouched.
 *
 * Deliberately NOT here: room lifecycle (create/join by code, seat claims) —
 * it lives in ./rooms and builds on this class via `runExclusive`, the same
 * serialization boundary commands use.
 */
import { randomBytes } from 'node:crypto';
import type { Server } from 'socket.io';
import type { GameCommand } from '../../src/lib/game/commands';
import type { AnyGameEvent } from '../../src/lib/game/events';
import { applyCommand, createGame } from '../../src/lib/game/engine/reducer';
import { rngForState } from '../../src/lib/game/rng';
import { buildSnapshot } from '../../src/lib/game/snapshot-schema';
import type { ModeId } from '../../src/lib/game/board-v1';
import type { GamePhase, GameState } from '../../src/lib/game/types';
import { gameRoomOf, toWireError, SOCKET_EVENTS, type WireCommandResult, type DeadlineBroadcast } from '../../src/lib/game/transport/protocol';
import type { TycoonDb } from '../db';
import { SubmitQueue } from './queue';
import { DeadlineScheduler, DEFAULT_DEADLINE_POLICY, type DeadlinePolicy, type DeadlineSubmission } from './deadlines';
import { projectClientState, type ClientGameState } from './redact';

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
  /** Deadline window overrides for deterministic tests; production uses the
   *  spec policy (Classic 90s / Quick 60s / Blitz 45s turn, 30s auction). */
  readonly deadlinePolicy?: DeadlinePolicy;
}

export class GameHost {
  private readonly queue = new SubmitQueue();
  private readonly deadlines: DeadlineScheduler;
  private state: GameState;

  private constructor(
    private readonly db: TycoonDb,
    private readonly io: Server,
    state: GameState,
    policy: DeadlinePolicy = DEFAULT_DEADLINE_POLICY,
  ) {
    this.state = state;
    this.deadlines = new DeadlineScheduler((compose) => this.runDeadline(compose), policy);
    // A resumed host re-arms from its snapshot mid-game (restart mid-decision).
    this.deadlines.sync(this.state);
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
    return { host: new GameHost(db, io, created.state, input.deadlinePolicy), gameId, roomCode };
  }

  /** Reload from the latest stored snapshot — the restart/resume path (spec criterion 9). */
  static resume(db: TycoonDb, io: Server, gameId: string, options: { deadlinePolicy?: DeadlinePolicy } = {}): GameHost | null {
    const snapshot = db.loadSnapshot(gameId);
    if (snapshot === null) return null;
    return new GameHost(db, io, snapshot.state, options.deadlinePolicy);
  }

  /** Queue a command from an authenticated session. Identity is stamped here,
   * inside the serialization boundary: the session's binding wins and a
   * client-claimed actorId/gameId are ignored (spec criterion 4). */
  submit(session: SubmitSession, raw: unknown): Promise<WireCommandResult> {
    return this.queue.push(() => this.submitNow(session, raw));
  }

  /** Run a task inside the same per-game serialization boundary as commands —
   *  the join/reconnect critical section (phase check + seat claim + catch-up
   *  read + room admission) so it cannot interleave with an application. */
  runExclusive<T>(task: () => T | Promise<T>): Promise<T> {
    return this.queue.push(task);
  }

  /** Drop the host: clear armed deadline windows and stop re-arming. */
  dispose(): void {
    this.deadlines.stop();
  }

  /** The authoritative phase — the room-lifecycle gate reads this, not the DB row. */
  get phase(): GamePhase {
    return this.state.phase;
  }

  /** The engine game id — the gateway's host-cache key and room-echo. */
  get gameId(): string {
    return this.state.gameId;
  }

  /** The redacted client projection of the current state (§4 boundary). */
  get clientState(): ClientGameState {
    return projectClientState(this.state);
  }

  /** The currently armed decision windows — broadcast with every state sync
   *  and on join/reconnect so the UI's DeadlineBar stays presentation-only. */
  get deadlineBroadcast(): DeadlineBroadcast {
    return this.deadlines.broadcastOf(this.state.gameId);
  }

  /** The deadline seam: run a server-composed submission inside the SAME
   *  per-game queue as player commands — composition and application in ONE
   *  queue task, so a player command can never interleave between them (that
   *  interleave made the composed expectedVersion stale and silently dropped
   *  the deadline, stalling the game). The compose closure sees the state as
   *  of execution — never a stale capture — and its scheduler generation
   *  check returns null for a stale or inapplicable expiry, which is dropped
   *  silently by design (the timer raced a state change that already
   *  resolved it). */
  private async runDeadline(compose: (state: GameState) => DeadlineSubmission | null): Promise<unknown> {
    return this.queue.push(() => {
      const submission = compose(this.state);
      if (submission === null) return undefined;
      // Stamp from the deadline's OWN session (the expired player or the
      // bank) — the same trust boundary every command crosses; nothing is
      // claimed.
      return this.submitNow(submission.session, submission.command);
    });
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
      command,
      events: result.events,
      snapshot: buildSnapshot(result.state),
    });
    // Re-arm the decision windows from the new state and publish them — every
    // state change grants a full fresh window for the now-pending decision.
    this.deadlines.sync(this.state);
    const room = gameRoomOf(this.state.gameId);
    for (const event of result.events as readonly AnyGameEvent[]) this.io.to(room).emit('game:event', event);
    this.io.to(room).emit('game:state', projectClientState(this.state));
    this.io.to(room).emit(SOCKET_EVENTS.deadline, this.deadlineBroadcast);
    return { ok: true, applied: true, events: result.events };
  }
}
