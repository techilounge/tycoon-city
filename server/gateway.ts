/**
 * The Socket.IO gateway (spec "Socket protocol"): session auth in the
 * handshake middleware, then per-connection command rate limiting — both
 * BEFORE the per-game queue — and identity stamped server-side so a client's
 * claimed actorId is ignored (spec criterion 4).
 *
 * Room lifecycle (PR 15): `game:create` and `game:join` mint session tokens
 * post-connect; a successful create/join attaches the session to the socket
 * so the connection is command-authenticated immediately. The join/reconnect
 * critical section (phase gate, seat claim, catch-up read, room admission)
 * runs inside the game's per-game queue — see rooms.ts.
 *
 * Rejection discipline: an unauthenticated or over-budget command emits
 * `game:error` and acks the error — never a disconnect, never state change.
 */
import type { Server, Socket } from 'socket.io';
import type { TycoonDb } from './db';
import { COMMAND_LIMIT, JOIN_LIMIT, SlidingWindowRateLimiter, type RateLimitConfig } from './rateLimit';
import { GameHost } from './game/gameHost';
import type { SubmitSession } from './game/gameHost';
import {
  broadcastOf,
  createRoom,
  parseCreateInput,
  parseJoinInput,
  prepareJoin,
  resolveRoomCode,
  RoomLifecycleError,
  sessionAckOf,
  sessionRoster,
} from './game/rooms';
import {
  SOCKET_EVENTS,
  gameRoomOf,
  type GatewayError,
  type RoomAck,
  type WireCommandResult,
} from '../src/lib/game/transport/protocol';

/** The session attached to a socket by the handshake middleware or a join. */
export interface SocketSession extends SubmitSession {
  readonly token: string;
}

/** Gateway wiring knobs — production defaults to the spec's published limits. */
export interface GatewayOptions {
  /** Per-connection command budget; default COMMAND_LIMIT (20 per 10 s). */
  readonly commandLimit?: RateLimitConfig;
  /** Per-IP fresh-join budget; default JOIN_LIMIT (5 per minute). */
  readonly joinLimit?: RateLimitConfig;
}

const SESSION_KEY = 'tycoonSession';

function sessionOf(socket: Socket): SocketSession | undefined {
  return (socket.data as { [SESSION_KEY]?: SocketSession })[SESSION_KEY];
}

function attachSession(socket: Socket, session: SocketSession): void {
  (socket.data as { [SESSION_KEY]?: SocketSession })[SESSION_KEY] = session;
}

export function setupGateway(io: Server, db: TycoonDb, options: GatewayOptions = {}): void {
  /** Hosts are loaded lazily per game and cached for the gateway's lifetime. */
  const hosts = new Map<string, GameHost>();

  const hostFor = (gameId: string): GameHost | null => {
    const existing = hosts.get(gameId);
    if (existing !== undefined) return existing;
    const resumed = GameHost.resume(db, io, gameId);
    if (resumed === null) return null;
    hosts.set(gameId, resumed);
    return resumed;
  };

  // Per-IP fresh-join budget, shared by create and join: both mint sessions
  // from an unauthenticated payload, so both are room-code-guessing surfaces.
  // Re-presented tokens are already authenticated and bypass it.
  const joinLimiter = new SlidingWindowRateLimiter(options.joinLimit ?? JOIN_LIMIT);
  const ipOf = (socket: Socket): string => socket.handshake.address ?? 'unknown';

  // Handshake auth: a presented token must resolve to a live session; an
  // anonymous connect is allowed to proceed (the room-join flow mints tokens
  // post-connect) but can never submit commands.
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (token === undefined) return next();
    if (typeof token !== 'string' || token.length === 0) return next(new Error('INVALID_SESSION'));
    const session = db.getSession(token);
    if (session === null) return next(new Error('INVALID_SESSION'));
    attachSession(socket, { token: session.token, gameId: session.gameId, actorId: session.actorId });
    db.touchSession(session.token);
    socket.join(gameRoomOf(session.gameId));
    next();
  });

  const roomErrorOf = (error: unknown): GatewayError => {
    if (error instanceof RoomLifecycleError) return { code: error.code, message: error.message };
    console.error('[tycoon-server] unexpected room error:', error);
    return { code: 'INTERNAL', message: 'Unexpected server error.' };
  };

  io.on('connection', (socket) => {
    const commandLimiter = new SlidingWindowRateLimiter(options.commandLimit ?? COMMAND_LIMIT);

    const rejectWith = (code: GatewayError['code'], message: string, respond: (r: WireCommandResult) => void): void => {
      const error: GatewayError = { code, message };
      socket.emit(SOCKET_EVENTS.error, error);
      respond({ ok: false, error });
    };

    // Create a room: validate, host the game (server-side seed), claim seat
    // one, attach the session, admit the socket, ack privately with the token.
    socket.on(SOCKET_EVENTS.create, (raw: unknown, ack: unknown) => {
      const respond = ackOf(ack);
      try {
        if (!joinLimiter.tryTake(ipOf(socket))) {
          throw new RoomLifecycleError('RATE_LIMITED', 'Too many rooms created — slow down.');
        }
        const input = parseCreateInput(raw);
        const created = createRoom(db, io, input);
        hosts.set(created.host.gameId, created.host);
        attachSession(socket, {
          token: created.session.token,
          gameId: created.session.gameId,
          actorId: created.session.actorId,
        });
        socket.join(gameRoomOf(created.host.gameId));
        // Creation is the one-seat join: authoritative state first, then the
        // full event history (at create: the seq-1 GAME_CREATED event) — the
        // creator's stream is gapless from the very first event.
        socket.emit(SOCKET_EVENTS.state, created.host.clientState);
        for (const event of db.getEvents(created.host.gameId, 1)) {
          socket.emit(SOCKET_EVENTS.event, event);
        }
        respond(created.ack);
      } catch (error) {
        const gatewayError = roomErrorOf(error);
        socket.emit(SOCKET_EVENTS.error, gatewayError);
        respond({ ok: false, error: gatewayError });
      }
    });

    // Join a room by code. Fresh joins claim the lowest free seat and are
    // gated on the LOBBY phase; a re-presented token re-authenticates instead
    // (any phase — the reconnect path) and streams catch-up events from
    // fromSeq. The critical section runs inside the game's queue.
    socket.on(SOCKET_EVENTS.join, (raw: unknown, ack: unknown) => {
      const respond = ackOf(ack);
      handleJoin(socket, raw, respond).catch((error: unknown) => {
        const gatewayError = roomErrorOf(error);
        socket.emit(SOCKET_EVENTS.error, gatewayError);
        respond({ ok: false, error: gatewayError });
      });
    });

    socket.on(SOCKET_EVENTS.command, (raw: unknown, ack: unknown) => {
      const respond = typeof ack === 'function' ? (ack as (result: WireCommandResult) => void) : () => {};
      const session = sessionOf(socket);

      // 1. Auth before everything — an unauthenticated command never reaches the queue.
      if (session === undefined) {
        rejectWith('UNAUTHENTICATED', 'Connect with a valid session token before submitting commands.', respond);
        return;
      }

      // 2. Rate limit before the queue (criterion 8) — never a disconnect, never state change.
      if (!commandLimiter.tryTake(socket.id)) {
        rejectWith('RATE_LIMITED', 'Too many commands — slow down.', respond);
        return;
      }

      // 3. The per-game queue runs the session-stamped command through applyCommand.
      let host: GameHost | null;
      try {
        host = hostFor(session.gameId);
      } catch (error) {
        // A snapshot that fails its refusal gate is server-side corruption — surfaced in logs, not crashed.
        console.error(`[tycoon-server] failed to load game ${session.gameId}:`, error);
        rejectWith('STATE_LOAD_FAILED', 'Stored game state could not be loaded.', respond);
        return;
      }
      if (host === null) {
        rejectWith('GAME_NOT_FOUND', 'No game exists for this session.', respond);
        return;
      }
      host.submit(session, raw).then(respond);
    });
  });

  /** The full join flow — everything here throws RoomLifecycleError-style
   *  failures that the caller converts to `game:error` + a failed ack. */
  async function handleJoin(socket: Socket, raw: unknown, respond: (r: RoomAck) => void): Promise<void> {
    const input = parseJoinInput(raw);

    // A presented token is validated before the join budget: reconnects
    // never burn (or exhaust) the per-IP room-guessing allowance.
    const presented = input.token === undefined ? null : db.getSession(input.token);
    if (input.token !== undefined && presented === null) {
      throw new RoomLifecycleError('INVALID_SESSION', 'The presented token is not valid.');
    }
    if (presented === null && !joinLimiter.tryTake(ipOf(socket))) {
      throw new RoomLifecycleError('RATE_LIMITED', 'Too many joins — slow down.');
    }

    const row = resolveRoomCode(db, input.code);
    if (presented !== null && presented.gameId !== row.gameId) {
      throw new RoomLifecycleError('INVALID_SESSION', 'The presented token belongs to a different room.');
    }

    let host: GameHost | null;
    try {
      host = hostFor(row.gameId);
    } catch (error) {
      // A snapshot that fails its refusal gate is server-side corruption —
      // surfaced in logs, not crashed, and never half-joined.
      console.error(`[tycoon-server] failed to load game ${row.gameId}:`, error);
      throw new RoomLifecycleError('STATE_LOAD_FAILED', 'Stored game state could not be loaded.');
    }
    if (host === null) throw new RoomLifecycleError('GAME_NOT_FOUND', 'No game exists for this room.');
    const gameHost: GameHost = host;

    const payload = await gameHost.runExclusive(() => {
      const prepared = prepareJoin(db, gameHost, row, input, presented);
      attachSession(socket, {
        token: prepared.session.token,
        gameId: prepared.session.gameId,
        actorId: prepared.session.actorId,
      });
      socket.join(gameRoomOf(row.gameId));
      // Authoritative state first, then missed events in stamped order — the
      // client ends consistent, and room admission before the emits keeps
      // live broadcasts ordered behind the catch-up.
      socket.emit(SOCKET_EVENTS.state, gameHost.clientState);
      for (const event of prepared.catchUpEvents) socket.emit(SOCKET_EVENTS.event, event);
      if (!prepared.reconnected) {
        const roster = sessionRoster(db, row.gameId, gameHost);
        io.to(gameRoomOf(row.gameId)).emit(SOCKET_EVENTS.joined, broadcastOf(row.roomCode, gameHost, prepared.session, roster));
      }
      return sessionAckOf(row.roomCode, gameHost, prepared.session, sessionRoster(db, row.gameId, gameHost));
    });
    respond(payload);
  }
}

function ackOf(ack: unknown): (result: RoomAck) => void {
  return typeof ack === 'function' ? (ack as (result: RoomAck) => void) : () => {};
}
