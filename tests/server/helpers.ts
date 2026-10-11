/**
 * Shared gateway test harness: a real Socket.IO server on an ephemeral port
 * over a throwaway SQLite file, with injectable rate-limit budgets (long-run
 * games override them; the limiter tests keep the published defaults). Each
 * suite owns its harness — the runner parallelizes test FILES, so nothing is
 * shared across files and every port/database is private to one suite.
 */
import fs from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Server as SocketIoServer } from 'socket.io';
import { io as createClient, type Socket as ClientSocket } from 'socket.io-client';
import { TycoonDb } from '../../server/db';
import { setupGateway } from '../../server/gateway';
import type { RateLimitConfig } from '../../server/rateLimit';

export interface HarnessOptions {
  /** Per-connection command budget; default: the published 20-per-10s. */
  readonly commandLimit?: RateLimitConfig;
  /** Per-IP fresh-join budget; default: the published 5-per-minute. */
  readonly joinLimit?: RateLimitConfig;
  /** Reopen an existing SQLite file (restart-durability tests). */
  readonly dbPath?: string;
}

export interface TestHarness {
  readonly port: number;
  readonly db: TycoonDb;
  readonly io: SocketIoServer;
  /** SQLite file path — a restart test reopens this file on a fresh server. */
  readonly dbPath: string;
  connect(auth?: Record<string, unknown>): Promise<ClientSocket>;
  /** Emit with an ack and a hard timeout — a missing ack fails the test. */
  ack<T = unknown>(socket: ClientSocket, event: string, payload: unknown): Promise<T>;
  /** The next payload of `event` on this socket (one-shot). */
  nextEvent<T = unknown>(socket: ClientSocket, event: string): Promise<T>;
  /** Every payload of `event` on this socket, in arrival order (taps live). */
  tap<T = unknown>(socket: ClientSocket, event: string): { readonly seen: readonly T[] };
  close(): Promise<void>;
}

export async function startHarness(options: HarnessOptions = {}): Promise<TestHarness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-srv-'));
  const dbPath = options.dbPath ?? path.join(dir, 'test.db');
  const db = TycoonDb.open(dbPath);
  // Bare http server: register a fallback request handler BEFORE socket.io
  // attaches (attach captures the listeners present at that moment and
  // defers non-socket requests to them) — otherwise plain HTTP requests
  // hang forever with no response.
  const httpServer = createServer((_req, res) => {
    res.statusCode = 404;
    res.end('not found');
  });
  const io = new SocketIoServer(httpServer);
  setupGateway(io, db, options);
  const clients: ClientSocket[] = [];

  const port = await new Promise<number>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => {
      const address = httpServer.address();
      const bound = typeof address === 'object' && address !== null ? address.port : 0;
      resolve(bound);
    });
  });

  return {
    port,
    db,
    io,
    dbPath,
    connect(auth: Record<string, unknown> = {}) {
      const client = createClient(`http://127.0.0.1:${port}`, { auth, transports: ['websocket'], forceNew: true });
      clients.push(client);
      return new Promise<ClientSocket>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('connect timeout')), 5_000);
        client.on('connect', () => {
          clearTimeout(timer);
          resolve(client);
        });
        client.on('connect_error', (error: Error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
    },
    ack<T>(socket: ClientSocket, event: string, payload: unknown): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`ack timeout for ${event}`)), 10_000);
        socket.emit(event, payload, (result: T) => {
          clearTimeout(timer);
          resolve(result);
        });
      });
    },
    nextEvent<T>(socket: ClientSocket, event: string): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), 10_000);
        socket.once(event, (payload: T) => {
          clearTimeout(timer);
          resolve(payload);
        });
      });
    },
    tap<T>(socket: ClientSocket, event: string) {
      const seen: T[] = [];
      socket.on(event, (payload: T) => seen.push(payload));
      return { seen };
    },
    close() {
      return new Promise<void>((resolve) => {
        for (const client of clients) client.disconnect();
        io.close(() => {
          httpServer.close(() => {
            try {
              db.close();
            } finally {
              resolve();
            }
          });
        });
        // Force-close keep-alive sockets so the runner exits promptly.
        httpServer.closeAllConnections?.();
      });
    },
  };
}

/** True when a key with exactly this name appears anywhere in the payload tree. */
export function hasKeyDeep(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((v) => hasKeyDeep(v, key));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).some(([k, v]) => k === key || hasKeyDeep(v, key));
  }
  return false;
}
