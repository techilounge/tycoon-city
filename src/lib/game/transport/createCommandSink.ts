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
import type { Socket as ClientSocket } from 'socket.io-client';
import {
  OnlineGameClient,
  saveSessionRecord,
  type OnlineClientCallbacks,
  type OnlineSessionRecord,
} from './onlineClient';

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

export interface LocalTransportOptions {
  readonly mode: 'local';
  /** The DOM storage the local transport persists through (the page passes window.localStorage). */
  readonly storage: Storage;
}

export interface OnlineTransportOptions {
  readonly mode: 'online';
  /** The room code to join. */
  readonly code: string;
  /** The display name (fresh joins claim a seat with it; re-auth keeps the stored one). */
  readonly name: string;
  /** The UI observation points — state, events, roster, faults, connection. */
  readonly callbacks: OnlineClientCallbacks;
  /** A stored credential re-presented for re-auth; absent → fresh join. */
  readonly session?: OnlineSessionRecord | null;
  /** Where the session record is persisted (the page passes window.sessionStorage). */
  readonly storage?: Storage;
  /** Test seam; defaults to the same-origin socket. */
  readonly socketFactory?: () => ClientSocket;
}

export type CreateCommandSinkOptions = LocalTransportOptions | OnlineTransportOptions;

/** The online transport: one joined client owning sink, events, connection. */
export interface OnlineTransportBundle {
  readonly mode: 'online';
  readonly client: OnlineGameClient;
}

/** The online branch: join the room, then persist the session record for the reconnect flow. */
async function createOnlineTransport(options: OnlineTransportOptions): Promise<OnlineTransportBundle> {
  const client = await OnlineGameClient.connect(
    { code: options.code, name: options.name, session: options.session ?? null, socketFactory: options.socketFactory },
    options.callbacks,
  );
  const session = client.getSession();
  if (options.storage !== undefined && session !== null) saveSessionRecord(options.storage, session.roomCode, session);
  return { mode: 'online', client };
}

/**
 * The single wiring point for client transports (spec "The five decisions"
 * item 3). Two branches, one factory:
 *
 * - `local` (sync, unchanged): the hot-seat wiring the page used to build by
 *   hand — one LocalSnapshotStore over the injected DOM storage, sinks
 *   created with `LocalCommandSink.create` and resumed with
 *   `LocalCommandSink.resume(snapshot, store)`.
 * - `online` (async — a room join must complete first): an OnlineGameClient
 *   joined to the room, its session record persisted to the given storage
 *   (per tab) so a refresh re-authenticates with the stored token.
 */
export function createCommandSink(options: LocalTransportOptions): TransportBundle;
export function createCommandSink(options: OnlineTransportOptions): Promise<OnlineTransportBundle>;
export function createCommandSink(options: LocalTransportOptions | OnlineTransportOptions): TransportBundle | Promise<OnlineTransportBundle> {
  if (options.mode === 'online') return createOnlineTransport(options);
  const store = new LocalSnapshotStore(options.storage);
  return {
    mode: 'local',
    store,
    createSink: (config) => LocalCommandSink.create(config),
    resumeSink: (snapshot) => LocalCommandSink.resume(snapshot, store),
  };
}
