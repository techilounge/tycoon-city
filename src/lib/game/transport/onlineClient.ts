/**
 * The online game client (spec "Client experience"): one orchestration object
 * that owns the room socket, the session record, the reconnect/resync loop,
 * and the gapless catch-up check — composing NetworkCommandSink (acks) and
 * SocketEventSource (events) under the transport-seam names.
 *
 * Authentication rides ONLY in the `game:join` payload, never in the socket
 * handshake: the server's join critical section runs inside the game's queue
 * (state broadcast → catch-up events → room admission → ack), so a token
 * re-presented there yields a perfectly ordered stream with no interleaved
 * live broadcasts. An anonymous connect stays deliberately unprivileged.
 *
 * Reconnect: Socket.IO auto-reconnects; every 'connect' runs the ONE join
 * routine — the first join claims a seat (fresh, LOBBY-only) or re-presents
 * the stored token (any phase), later runs re-present the token with
 * `fromSeq = lastSeen + 1` and the server streams exactly the missed events.
 * A single join is in flight at any moment; a disconnect invalidates it.
 */
import { io, type Socket as ClientSocket } from 'socket.io-client';
import type { ModeId } from '../board-v1';
import type { AnyGameEvent } from '../events';
import type { PlayerId } from '../types';
import {
  EventGapError,
  NetworkCommandSink,
  SocketEventSource,
  type NetworkSubmitResult,
  type TransportFault,
} from './networkSink';
import {
  SOCKET_EVENTS,
  type JoinedBroadcast,
  type RoomAck,
  type RosterEntry,
  type SessionAck,
  type WireError,
} from './protocol';
import type { ClientGameState } from './clientState';

/** Connection surfaces as the ConnectionBadge's states (spec component list). */
export type ConnectionState = 'connecting' | 'live' | 'reconnecting' | 'offline';

/** The joiner's own credential, stored per room code (sessionStorage) and re-presented on reconnect. */
export interface OnlineSessionRecord {
  readonly token: string;
  readonly gameId: string;
  readonly roomCode: string;
  readonly actorId: PlayerId;
  readonly name: string;
}

/** What the UI observes: state, events, roster, faults, connection. */
export interface OnlineClientCallbacks {
  readonly onState: (state: ClientGameState) => void;
  readonly onEvent: (event: AnyGameEvent) => void;
  readonly onRoster: (roster: readonly RosterEntry[]) => void;
  readonly onFault: (fault: TransportFault) => void;
  readonly onConnection: (state: ConnectionState) => void;
}

/** Budget for room joins (create/join/resync) — same budget as command acks. */
const JOIN_ACK_TIMEOUT_MS = 10_000;

/** Bound on reaching the server at all before the first connect() gives up. */
const INITIAL_CONNECT_TIMEOUT_MS = 15_000;

/** A room-lifecycle failure surfaced to the UI (thrown by the one-shot helpers). */
export class WireFaultError extends Error {
  constructor(readonly fault: TransportFault) {
    super(fault.message);
    this.name = 'WireFaultError';
  }
}

/** Default socket: same origin, fresh connection per client (lobby + game each own one). */
export function defaultSocketFactory(): ClientSocket {
  return io({ forceNew: true });
}

/** One emit + ack round trip with a hard timeout — the shared wire primitive. */
function ackOf<T>(socket: ClientSocket, event: string, payload: unknown, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new WireFaultError({
          code: 'ACK_TIMEOUT',
          message: `The server did not answer the ${event} request. Check your connection and try again.`,
        }),
      );
    }, timeoutMs);
    socket.emit(event, payload, (result: T) => {
      clearTimeout(timer);
      resolve(result);
    });
  });
}

/** Lobby one-shot: create a room and claim seat one. Throws WireFaultError on any refusal. */
export async function createRoomOnWire(
  socket: ClientSocket,
  input: { mode: ModeId; seatCount: number; name: string },
  timeoutMs = JOIN_ACK_TIMEOUT_MS,
): Promise<SessionAck> {
  const ack = await ackOf<RoomAck>(socket, SOCKET_EVENTS.create, input, timeoutMs);
  if (!ack.ok) throw new WireFaultError(ack.error);
  return ack;
}

/** Lobby one-shot: join (or re-auth) by room code. Throws WireFaultError on any refusal. */
export async function joinRoomOnWire(
  socket: ClientSocket,
  input: { code: string; name: string; token?: string; fromSeq?: number },
  timeoutMs = JOIN_ACK_TIMEOUT_MS,
): Promise<SessionAck> {
  const ack = await ackOf<RoomAck>(socket, SOCKET_EVENTS.join, input, timeoutMs);
  if (!ack.ok) throw new WireFaultError(ack.error);
  return ack;
}

// ---------------------------------------------------------------------------
// Session storage — per room code, per tab (sessionStorage): two tabs on one
// device are two players; a refresh keeps the session for the reconnect flow.
// ---------------------------------------------------------------------------

export function sessionKeyFor(roomCode: string): string {
  return `tycoon-city:online-session:${roomCode.trim().toUpperCase()}`;
}

export function saveSessionRecord(storage: Storage, roomCode: string, record: OnlineSessionRecord): void {
  storage.setItem(sessionKeyFor(roomCode), JSON.stringify(record));
}

export function loadSessionRecord(storage: Storage, roomCode: string): OnlineSessionRecord | null {
  const raw = storage.getItem(sessionKeyFor(roomCode));
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<OnlineSessionRecord>;
    if (
      typeof parsed.token !== 'string' ||
      typeof parsed.gameId !== 'string' ||
      typeof parsed.roomCode !== 'string' ||
      typeof parsed.actorId !== 'string' ||
      typeof parsed.name !== 'string'
    ) {
      return null;
    }
    return parsed as OnlineSessionRecord;
  } catch {
    return null; // malformed record — treated exactly like a missing session
  }
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export interface OnlineConnectInput {
  readonly code: string;
  readonly name: string;
  /** Stored credential — present: re-auth (any phase); absent: fresh join (LOBBY only). */
  readonly session?: OnlineSessionRecord | null;
  /** Test seam; defaults to the same-origin socket. */
  readonly socketFactory?: () => ClientSocket;
}

export class OnlineGameClient {
  readonly sink: NetworkCommandSink;
  readonly events: SocketEventSource;

  private readonly socket: ClientSocket;
  private readonly callbacks: OnlineClientCallbacks;
  private readonly code: string;
  private readonly name: string;
  private session: OnlineSessionRecord | null;
  private connection: ConnectionState = 'connecting';
  private roster: readonly RosterEntry[] = [];
  /** Join generation — a disconnect or a newer join invalidates an in-flight one. */
  private generation = 0;
  private joinedOnce = false;
  private joinInFlight: Promise<void> | null = null;
  private closed = false;
  private firstJoinSettled = false;
  private firstJoinResolve: (() => void) | null = null;
  private firstJoinReject: ((error: WireFaultError) => void) | null = null;
  private firstJoinClearTimer: (() => void) | null = null;

  private constructor(socket: ClientSocket, input: OnlineConnectInput, callbacks: OnlineClientCallbacks) {
    this.socket = socket;
    this.code = input.code;
    this.name = input.name;
    this.session = input.session ?? null;
    this.callbacks = callbacks;
    this.sink = new NetworkCommandSink(socket);
    this.events = new SocketEventSource(socket, (error: EventGapError) => {
      // The gapless check tripped: surface it, then heal by re-joining from
      // the last contiguously seen sequence.
      this.callbacks.onFault({
        code: 'EVENT_GAP',
        message: `Event stream gap detected (${error.expected} → ${error.received}) — resyncing.`,
      });
      void this.resync();
    });
    // The owner's event feed is wired at construction — before any join — so
    // create-time and join-time catch-up streams are never missed.
    this.events.subscribeAll((event) => this.callbacks.onEvent(event));

    // The single join trigger: a fresh io() socket always fires 'connect' on
    // every (re)connection — never call resync from anywhere else.
    socket.on('connect', () => {
      void this.resync();
    });
    socket.on('disconnect', (reason: string) => {
      // Invalidate any in-flight join (its ack is gone with the socket) and
      // let the next 'connect' start a clean one.
      this.generation += 1;
      this.joinInFlight = null;
      if (this.closed) return;
      this.setConnection('reconnecting');
      // socket.io-client never auto-reconnects after a server-initiated
      // disconnect ('io server disconnect') — the documented way back is an
      // explicit connect(). Transport-level drops retry on their own. If the
      // session is truly gone, the re-auth join surfaces INVALID_SESSION.
      if (reason === 'io server disconnect') this.socket.connect();
    });
    socket.on('connect_error', (error: Error) => {
      if (this.closed) return;
      this.setConnection('offline');
      if (error.message.includes('INVALID_SESSION')) {
        // The middleware rejected the connection itself — retrying with this
        // socket can never succeed. Stop the loop; the UI offers a fresh join.
        this.callbacks.onFault({ code: 'INVALID_SESSION', message: 'Your session expired — rejoin the room.' });
        this.socket.disconnect();
        this.settleFirstJoin({ code: 'INVALID_SESSION', message: 'Your session expired — rejoin the room.' });
      }
    });
    socket.on(SOCKET_EVENTS.state, (state: ClientGameState) => {
      this.callbacks.onState(state);
    });
    socket.on(SOCKET_EVENTS.joined, (broadcast: JoinedBroadcast) => {
      this.roster = broadcast.roster;
      this.callbacks.onRoster(broadcast.roster);
    });
    socket.on(SOCKET_EVENTS.error, (error: WireError) => {
      this.callbacks.onFault(error);
    });
  }

  /**
   * Connect + await the first successful join. Rejects with WireFaultError on
   * an immediate refusal (unknown room, session invalid) or when the server
   * cannot be reached in time.
   */
  static async connect(input: OnlineConnectInput, callbacks: OnlineClientCallbacks): Promise<OnlineGameClient> {
    const socket = (input.socketFactory ?? defaultSocketFactory)();
    const client = new OnlineGameClient(socket, input, callbacks);
    try {
      await new Promise<void>((resolve, reject) => {
        client.firstJoinResolve = resolve;
        client.firstJoinReject = reject;
        const timer = setTimeout(() => {
          reject(new WireFaultError({ code: 'ACK_TIMEOUT', message: 'Could not reach the room. Check your connection and try again.' }));
        }, INITIAL_CONNECT_TIMEOUT_MS);
        client.firstJoinClearTimer = () => clearTimeout(timer);
      });
    } catch (error) {
      client.close(); // no owner for a failed connect — stop the retry loop
      throw error;
    }
    return client;
  }

  get connectionState(): ConnectionState {
    return this.connection;
  }

  getSession(): OnlineSessionRecord | null {
    return this.session;
  }

  getRoster(): readonly RosterEntry[] {
    return this.roster;
  }

  /** Stop listening and drop the socket (navigation away / unmount / fatal). */
  close(): void {
    this.closed = true;
    this.firstJoinClearTimer?.();
    this.socket.removeAllListeners();
    this.socket.disconnect();
  }

  /** Settle the connect() promise exactly once (first settlement wins). */
  private settleFirstJoin(fault: TransportFault | null): void {
    if (this.firstJoinSettled) return;
    this.firstJoinSettled = true;
    this.firstJoinClearTimer?.();
    if (fault === null) this.firstJoinResolve?.();
    else this.firstJoinReject?.(new WireFaultError(fault));
  }

  /** Exactly one join in flight; a second caller awaits the same attempt. */
  private async resync(): Promise<void> {
    if (this.closed) return;
    if (this.joinInFlight !== null) return this.joinInFlight;
    const attempt = this.runJoin();
    this.joinInFlight = attempt;
    try {
      await attempt;
    } finally {
      if (this.joinInFlight === attempt) this.joinInFlight = null;
    }
  }

  /** One (re)join attempt. Never rejects; surfaces faults through callbacks. */
  private async runJoin(): Promise<void> {
    const generation = ++this.generation;
    const token = this.session?.token;
    if (this.connection === 'offline') this.setConnection('connecting');
    try {
      const ack = await joinRoomOnWire(this.socket, {
        code: this.code,
        name: this.session?.name ?? this.name,
        ...(token === undefined ? {} : { token }),
        fromSeq: this.session === null ? 1 : this.events.lastSeenSeq(this.session.gameId) + 1,
      });
      if (this.closed || generation !== this.generation) return; // superseded / closed
      this.session = {
        token: ack.token,
        gameId: ack.gameId,
        roomCode: ack.roomCode,
        actorId: ack.actorId,
        name: this.session?.name ?? this.name,
      };
      this.roster = ack.roster;
      this.callbacks.onRoster(ack.roster);
      this.setConnection('live');
      this.joinedOnce = true;
      this.settleFirstJoin(null);
    } catch (error) {
      if (this.closed) return;
      if (generation !== this.generation) {
        // Superseded (a disconnect invalidated this attempt). If the FIRST
        // join never landed, the connect() promise still needs settling —
        // the newest attempt's outcome (or the outer timer) provides it.
        if (!this.joinedOnce) this.settleFirstJoin(this.faultOf(error));
        return;
      }
      this.setConnection('offline');
      this.callbacks.onFault(this.faultOf(error));
      if (!this.joinedOnce) this.settleFirstJoin(this.faultOf(error));
    }
  }

  private faultOf(error: unknown): TransportFault {
    if (error instanceof WireFaultError) return error.fault;
    return { code: 'INTERNAL', message: 'Unexpected client error while joining.' };
  }

  private setConnection(state: ConnectionState): void {
    if (this.connection === state) return;
    this.connection = state;
    this.callbacks.onConnection(state);
  }
}

/** The submit result type re-exported for the UI layer's convenience. */
export type { NetworkSubmitResult };
