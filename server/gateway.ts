/**
 * The Socket.IO gateway (spec "Socket protocol"). This first layer proves the
 * one-port wiring (spec risk 3): sockets ride the same HTTP server as the
 * Next.js app. The session-auth middleware, rate limiting, and the
 * authoritative GameHost build on this wiring in the next layers of PR 14.
 */
import type { Server, Socket } from 'socket.io';

/** Liveness probe for boot smoke tests — an ack here proves the socket path serves on the app port. */
const PING_EVENT = 'tycoon:ping';

export function setupGateway(io: Server): void {
  io.on('connection', (socket: Socket) => {
    socket.on(PING_EVENT, (ack?: unknown) => {
      if (typeof ack === 'function') (ack as (result: unknown) => void)({ pong: true, socketId: socket.id });
    });
  });
}
