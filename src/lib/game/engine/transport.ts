/**
 * Transport-shaped seams (spec §2.3, §10): CommandSink, EventSource,
 * SnapshotStore, and the Phase 1 local wiring.
 *
 * Commands and events are plain serializable JSON. Phase 1 runs everything
 * in-process; Phase 2 swaps implementations — a WebSocket RPC sink, server
 * fan-out source, and a server snapshot store — without changing these
 * contracts. The client submits commands and renders projections; it never
 * becomes authoritative.
 *
 * The `EventSource` name intentionally matches the spec; it shadows the DOM
 * global of the same name inside this module only.
 */
import type { GameCommand } from '../commands';
import type { AnyGameEvent } from '../events';
import { rngForState } from '../rng';
import type { GameState } from '../types';
import { buildSnapshot, type GameSnapshot } from '../snapshot-schema';
import { applyCommand, createGame, type CommandResult, type CreateGameInput } from './reducer';

export type Unsubscribe = () => void;

/** Phase 1: LocalCommandSink resolves applyCommand in-process. Phase 2: WebSocket RPC. */
export interface CommandSink {
  submit(command: GameCommand): Promise<CommandResult>;
}

/** Event fan-out from a sequence — also the reconnection catch-up path (spec §10). */
export interface EventSource {
  subscribe(gameId: string, fromSeq: number, onEvent: (event: AnyGameEvent) => void): Unsubscribe;
}

/** Persistent checkpoints. Phase 1: in-memory now, localStorage wiring in PR 11; Phase 2: server DB. */
export interface SnapshotStore {
  save(snapshot: GameSnapshot): void;
  load(gameId: string): GameSnapshot | null;
}

/** Append-only per-game event log with live listeners. */
export class InMemoryEventLog {
  private readonly events: AnyGameEvent[] = [];
  private readonly listeners = new Set<(event: AnyGameEvent) => void>();

  append(events: readonly AnyGameEvent[]): void {
    for (const event of events) {
      this.events.push(event);
      for (const listener of this.listeners) listener(event);
    }
  }

  subscribe(gameId: string, fromSeq: number, onEvent: (event: AnyGameEvent) => void): Unsubscribe {
    const deliver = (event: AnyGameEvent): void => {
      if (event.gameId === gameId && event.sequence >= fromSeq) onEvent(event);
    };
    // Catch-up first (copy: live deliveries must not double-fire mid-iteration).
    for (const event of [...this.events]) deliver(event);
    this.listeners.add(deliver);
    return () => {
      this.listeners.delete(deliver);
    };
  }
}

export class InMemoryEventSource implements EventSource {
  constructor(private readonly log: InMemoryEventLog) {}

  subscribe(gameId: string, fromSeq: number, onEvent: (event: AnyGameEvent) => void): Unsubscribe {
    return this.log.subscribe(gameId, fromSeq, onEvent);
  }
}

export class InMemorySnapshotStore implements SnapshotStore {
  private readonly byGameId = new Map<string, GameSnapshot>();

  save(snapshot: GameSnapshot): void {
    this.byGameId.set(snapshot.gameId, snapshot);
  }

  load(gameId: string): GameSnapshot | null {
    return this.byGameId.get(gameId) ?? null;
  }
}

export interface LocalCommandSinkOptions extends CreateGameInput {
  /** Optional persistence seam; defaults to in-memory. PR 11 wires localStorage (spec §11). */
  readonly snapshots?: SnapshotStore;
}

/**
 * Phase 1 wiring (spec §2.3): the sink owns the state and the event log and
 * calls applyCommand in-process, seeding the RNG from the state's persisted
 * word. Submitting a duplicate commandId returns the current state plus the
 * STORED events of the original application — the §2.1 step-4 contract —
 * sourced from this sink's command log (state itself keeps only ids, §2.4).
 */
export class LocalCommandSink implements CommandSink {
  static create(options: LocalCommandSinkOptions): LocalCommandSink {
    const created = createGame({ gameId: options.gameId, seed: options.seed, playerIds: options.playerIds, mode: options.mode });
    if (!created.ok) throw created.error;
    return new LocalCommandSink(created.state, created.events, options.snapshots ?? new InMemorySnapshotStore());
  }

  /**
   * Resume (spec §2.4): continue a game from a schema-validated snapshot.
   * The resumed log starts empty — state carries the full truth — and event
   * sequences keep their per-game continuity because the reducer derives
   * them from state (gapless across the fold).
   */
  static resume(snapshot: GameSnapshot, snapshots?: SnapshotStore): LocalCommandSink {
    return new LocalCommandSink(snapshot.state, [], snapshots ?? new InMemorySnapshotStore());
  }

  /** EventSource over this sink's log. */
  readonly events: EventSource;

  private readonly log: InMemoryEventLog;
  private readonly snapshots: SnapshotStore;
  private readonly storedEventsByCommandId = new Map<string, AnyGameEvent[]>();
  private currentState: GameState;

  private constructor(initialState: GameState, initialEvents: readonly AnyGameEvent[], snapshots: SnapshotStore) {
    this.currentState = initialState;
    this.log = new InMemoryEventLog();
    this.events = new InMemoryEventSource(this.log);
    this.snapshots = snapshots;
    this.log.append(initialEvents);
  }

  submit(command: GameCommand): Promise<CommandResult> {
    const result = applyCommand(this.currentState, command, rngForState(this.currentState.rngState));
    if (!result.ok) return Promise.resolve(result);
    if (result.applied) {
      this.currentState = result.state;
      this.log.append(result.events);
      this.storedEventsByCommandId.set(command.commandId, [...result.events]);
      if (command.type === 'SAVE_SNAPSHOT') this.snapshots.save(this.snapshot());
      return Promise.resolve(result);
    }
    // Idempotent retry: same state, the original events (spec §2.1 step 4).
    const stored = this.storedEventsByCommandId.get(command.commandId) ?? [];
    return Promise.resolve({ ok: true, state: this.currentState, events: stored, applied: false });
  }

  state(): GameState {
    return this.currentState;
  }

  /** The current state as a schema-stamped snapshot (spec §2.4). */
  snapshot(): GameSnapshot {
    return buildSnapshot(this.currentState);
  }
}
