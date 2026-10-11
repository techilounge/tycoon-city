#!/usr/bin/env node
/**
 * Tycoon City custom server (Phase 2, spec decision 1): one Node process —
 * run with tsx — serves the Next.js app (/, /game, /demo) and the game
 * sockets on one port. Dev mode wraps the next dev compiler; production
 * serves the `next build` output.
 *
 * Run: `npm run dev` (development) · `npm start` (production, after `next build`).
 * Config: PORT (default 3000) · TYCOON_DB_PATH (default ./data/tycoon.db) ·
 * NODE_ENV=production for the prod build.
 *
 * The machine-readable ready line on stdout is the boot contract for the
 * smoke test and tooling; do not remove it.
 */
import { DEFAULT_DB_PATH } from './server/db';
import { startServer } from './server/start';

function envPort(): number {
  const raw = process.env.PORT;
  if (raw === undefined || raw === '') return 3000;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`PORT must be a non-negative integer, got: ${raw}`);
  }
  return value;
}

const port = envPort();
const dev = process.env.NODE_ENV !== 'production';
const dbPath = process.env.TYCOON_DB_PATH ?? DEFAULT_DB_PATH;

startServer({ port, dev, dbPath })
  .then((server) => {
    process.stdout.write(`${JSON.stringify({ event: 'ready', port: server.port, dev })}\n`);

    let closing = false;
    const shutdown = (signal: string): void => {
      if (closing) return;
      closing = true;
      process.stdout.write(`${JSON.stringify({ event: 'shutdown', signal })}\n`);
      // Bound the graceful close so orchestrators and test runners never hang.
      const forceExit = setTimeout(() => process.exit(0), 3_000);
      forceExit.unref();
      server.close().then(
        () => process.exit(0),
        (error: unknown) => {
          console.error('[tycoon-server] error during shutdown:', error);
          process.exit(1);
        },
      );
    };
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
  })
  .catch((error: unknown) => {
    console.error('[tycoon-server] failed to start:', error);
    process.exit(1);
  });
