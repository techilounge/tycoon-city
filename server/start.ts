/**
 * One Node process for everything (spec decision 1): the Next.js app and the
 * game sockets on a single HTTP port. Dev mode wraps the same compiler as
 * `next dev`; production serves the `next build` output. The SQLite
 * persistence layer attaches here in the next PR 14 layer.
 */
import { createServer, type Server as HttpServer } from 'node:http';
import path from 'node:path';
import next from 'next';
import { Server } from 'socket.io';
import { setupGateway } from './gateway';

export interface StartServerOptions {
  /** Port to listen on; 0 picks an ephemeral port (used by the boot smoke test). */
  readonly port: number;
  /** True wraps the next dev compiler; false serves the production build in .next. */
  readonly dev: boolean;
}

export interface RunningServer {
  /** The actually-bound port (resolves ephemeral picks). */
  readonly port: number;
  readonly io: Server;
  readonly httpServer: HttpServer;
  /** Stops sockets and HTTP; safe to call once. */
  close(): Promise<void>;
}

export async function startServer(options: StartServerOptions): Promise<RunningServer> {
  const app = next({ dev: options.dev, dir: path.resolve(__dirname, '..') });
  await app.prepare();
  const handle = app.getRequestHandler();

  const httpServer = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      // A failed request is surfaced, never silently dropped.
      console.error('[tycoon-server] request handler error:', error);
      if (!res.headersSent) res.statusCode = 500;
      res.end('internal error');
    });
  });
  const io = new Server(httpServer);
  setupGateway(io);

  const port = await new Promise<number>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(options.port, () => {
      const address = httpServer.address();
      resolve(typeof address === 'object' && address !== null ? address.port : options.port);
    });
  });

  return {
    port,
    io,
    httpServer,
    close: () =>
      new Promise<void>((resolve) => {
        io.close(() => {
          httpServer.close(() => resolve());
        });
        // Force-close keep-alive sockets so test runners and SIGTERM exit promptly.
        httpServer.closeAllConnections?.();
      }),
  };
}
