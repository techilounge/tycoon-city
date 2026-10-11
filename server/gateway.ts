/**
 * The Socket.IO gateway (spec "Socket protocol"): session auth in the
 * handshake middleware, then per-connection command rate limiting — both
 * BEFORE the per-game queue — and identity stamped server-side so a client's
 * claimed actorId is ignored (spec criterion 4).
 *
 * Rejection discipline: an unauthenticated or over-budget command emits
 * `game:error` and acks the error — never a disconnect, never state change.
 */
import type { Server, Socket } from 'socket.io';
import type { TycoonDb } from './db';
import { COMMAND_LIMIT, SlidingWindowRateLimiter } from './rateLimit';
import { GameHost } from './game/gameHost';
import type { SubmitSession } from './game/gameHost';
import {
  SOCKET_EVENTS,
  gameRoomOf,
  type GatewayError,
  type WireCommandResult,
} from '../src/lib/game/transport/protocol';

/** The session attached to a socket by the handshake middleware. */
export interface SocketSession extends SubmitSession {
  readonly token: string;
}

const SESSION_KEY = 'tycoonSession';

function sessionOf(socket: Socket): SocketSession | undefined {
  return (socket.data as { [SESSION_KEY]?: SocketSession })[SESSION_KEY];
}

export function setupGateway(io: Server, db: TycoonDb): void {
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

  // Handshake auth: a presented token must resolve to a live session; an
  // anonymous connect is allowed to proceed (the room-join flow, PR 15,
  // mints tokens post-connect) but can never submit commands.
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (token === undefined) return next();
    if (typeof token !== 'string' || token.length === 0) return next(new Error('INVALID_SESSION'));
    const session = db.getSession(token);
    if (session === null) return next(new Error('INVALID_SESSION'));
    (socket.data as { [SESSION_KEY]?: SocketSession })[SESSION_KEY] = {
      token: session.token,
      gameId: session.gameId,
      actorId: session.actorId,
    };
    db.touchSession(session.token);
    socket.join(gameRoomOf(session.gameId));
    next();
  });

  io.on('connection', (socket) => {
    const commandLimiter = new SlidingWindowRateLimiter(COMMAND_LIMIT);

    const rejectWith = (code: GatewayError['code'], message: string, respond: (r: WireCommandResult) => void): void => {
      const error: GatewayError = { code, message };
      socket.emit(SOCKET_EVENTS.error, error);
      respond({ ok: false, error });
    };

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
}
