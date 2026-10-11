/**
 * The client transport factory (spec "The five decisions" item 3, seam map §5
 * item 4): /game asks this module for its transport instead of constructing
 * one inline. This PR ships the LOCAL branch only — the hot-seat wiring it
 * returns is exactly what the page used to build by hand, bit for bit. The
 * online branch (NetworkCommandSink over the socket protocol) lands with the
 * Phase 2 client transport PR and is a loud typed error until then.
 */
import type { CreateGameInput } from '../engine/reducer';
import { LocalCommandSink } from '../engine/transport';
import type { GameSnapshot } from '../snapshot-schema';
import { LocalSnapshotStore } from '../ui/persistence';

/** How the page reaches a game: local hot-seat today, networked in the client transport PR. */
export type TransportMode = 'local' | 'online';

/**
 * The local hot-seat transport. The snapshot store outlives any one sink —
 * the page creates it once per session and autosaves through it — while
 * sinks are per game (fresh create or snapshot resume), so the bundle owns
 * the store and hands out sinks built against it.
 */
export interface TransportBundle {
  readonly mode: 'local';
  /** The browser snapshot store backing startup read, autosave, and resume. */
  readonly store: LocalSnapshotStore;
  /** Fresh hot-seat game: same construction the page did inline (no snapshots target — SAVE_SNAPSHOT lands in the sink's in-memory store). */
  createSink(config: CreateGameInput): LocalCommandSink;
  /** Resume from a schema-validated snapshot, injecting the browser store (as the inline call did). */
  resumeSink(snapshot: GameSnapshot): LocalCommandSink;
}

export interface CreateCommandSinkOptions {
  readonly mode: TransportMode;
  /** The DOM storage the local transport persists through (the page passes window.localStorage). */
  readonly storage: Storage;
}

/** Thrown when a caller asks for a transport branch this build does not ship. */
export class TransportNotAvailableError extends Error {
  constructor(mode: TransportMode) {
    super(`transport mode "${mode}" is not available in this build; online play arrives with the Phase 2 client transport`);
    this.name = 'TransportNotAvailableError';
  }
}

/**
 * The single wiring point for client transports. The local branch preserves
 * the previous inline construction exactly: one LocalSnapshotStore over the
 * injected DOM storage, sinks created with `LocalCommandSink.create` (no
 * snapshots target) and resumed with `LocalCommandSink.resume(snapshot, store)`.
 */
export function createCommandSink(options: CreateCommandSinkOptions): TransportBundle {
  if (options.mode === 'online') throw new TransportNotAvailableError('online');
  const store = new LocalSnapshotStore(options.storage);
  return {
    mode: 'local',
    store,
    createSink: (config) => LocalCommandSink.create(config),
    resumeSink: (snapshot) => LocalCommandSink.resume(snapshot, store),
  };
}
