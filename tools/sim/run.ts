/**
 * CLI entry (spec §8 / §14): run the seeded matrix, write JSON results,
 * and optionally render docs/ECONOMY.md.
 *
 * Usage:
 *   npm run sim -- --seeds=500 --md=docs/ECONOMY.md
 *   npm run sim -- --seeds=20
 *   npm run sim -- --modes=BLITZ --players=2,3 --seeds=50 --md=/tmp/blk.md
 *   npm run sim -- --from-json=tools/sim/results/sim-results.json --md=docs/ECONOMY.md
 *
 * --from-json re-renders the report from saved matrix summaries without
 * re-simulating (rendering is a pure function of the summaries); the
 * committed report is still reproducible from seeds alone.
 *
 * Full 500-seed matrices are a local/scripted job (spec §14); CI covers
 * the 20-seed smoke through the normal test suite instead.
 */
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ModeId } from '../../src/lib/game/board-v1';
import { MATRIX_MODES, MATRIX_PLAYER_COUNTS, runMatrix, type MatrixResult } from './matrix';
import { renderEconomyReport } from './report';

interface CliOptions {
  readonly modes: readonly ModeId[];
  readonly playerCounts: readonly number[];
  readonly seedCount: number;
  readonly markdownPath: string | null;
  readonly jsonPath: string | null;
  readonly fromJsonPath: string | null;
}

function parseList(value: string | undefined): number[] | undefined {
  if (!value) return undefined;
  const parsed = value.split(',').map((token) => Number.parseInt(token.trim(), 10));
  if (parsed.some((n) => !Number.isInteger(n) || n <= 0)) {
    throw new Error(`invalid number list: ${value}`);
  }
  return parsed;
}

function parseModeList(value: string | undefined): ModeId[] | undefined {
  if (!value) return undefined;
  const parsed = value.split(',').map((token) => token.trim().toUpperCase() as ModeId);
  for (const mode of parsed) {
    if (!MATRIX_MODES.includes(mode)) throw new Error(`unknown mode ${mode} (known: ${MATRIX_MODES.join(', ')})`);
  }
  return parsed;
}

function parseOptions(argv: readonly string[]): CliOptions {
  let seedCount = 500;
  let markdownPath: string | null = null;
  let jsonPath: string | null = 'tools/sim/results/sim-results.json';
  let modes: ModeId[] | undefined;
  let playerCounts: number[] | undefined;
  let fromJsonPath: string | null = null;
  for (const arg of argv) {
    if (arg.startsWith('--seeds=')) {
      seedCount = Number.parseInt(arg.slice('--seeds='.length), 10);
      if (!Number.isInteger(seedCount) || seedCount <= 0) throw new Error(`invalid --seeds: ${arg}`);
    } else if (arg.startsWith('--md=')) {
      markdownPath = arg.slice('--md='.length);
    } else if (arg.startsWith('--json=')) {
      jsonPath = arg.slice('--json='.length);
    } else if (arg.startsWith('--from-json=')) {
      fromJsonPath = arg.slice('--from-json='.length);
    } else if (arg.startsWith('--modes=')) {
      modes = parseModeList(arg.slice('--modes='.length));
    } else if (arg.startsWith('--players=')) {
      playerCounts = parseList(arg.slice('--players='.length));
    } else if (arg === '--no-json') {
      jsonPath = null;
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  return {
    modes: modes ?? MATRIX_MODES,
    playerCounts: playerCounts ?? MATRIX_PLAYER_COUNTS,
    seedCount,
    markdownPath,
    jsonPath,
    fromJsonPath,
  };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));

  if (options.fromJsonPath) {
    // Re-render only: load saved summaries and render the report. No
    // simulation runs, so no seed count is needed.
    const saved = JSON.parse(readFileSync(options.fromJsonPath, 'utf8')) as MatrixResult;
    if (!options.markdownPath) throw new Error('--from-json requires --md=<path> (nothing else to do)');
    mkdirSync(dirname(options.markdownPath), { recursive: true });
    writeFileSync(options.markdownPath, renderEconomyReport(saved));
    process.stderr.write(`sim: rendered ${options.markdownPath} from ${options.fromJsonPath}\n`);
    return;
  }

  const started = Date.now();
  process.stderr.write(`sim: ${options.modes.length * options.playerCounts.length} cells × ${options.seedCount} seeds\n`);

  const result: MatrixResult = await runMatrix({
    modes: options.modes,
    playerCounts: options.playerCounts,
    seedCount: options.seedCount,
    onProgress: (cellIndex, totalCells, mode, players, completed) => {
      if (completed % 50 === 0 || completed === options.seedCount) {
        process.stderr.write(`sim: cell ${cellIndex + 1}/${totalCells} ${mode} ${players}p — ${completed} games\n`);
      }
    },
  });

  if (options.jsonPath) {
    const payload = JSON.stringify(
      result,
      (key, value) => (key === 'games' ? undefined : value), // per-game records stay out of the summary JSON
      2,
    );
    mkdirSync(dirname(options.jsonPath), { recursive: true });
    writeFileSync(options.jsonPath, `${payload}\n`);
    process.stderr.write(`sim: wrote ${options.jsonPath}\n`);
  }
  if (options.markdownPath) {
    const markdown = renderEconomyReport(result);
    mkdirSync(dirname(options.markdownPath), { recursive: true });
    writeFileSync(options.markdownPath, markdown);
    process.stderr.write(`sim: wrote ${options.markdownPath}\n`);
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  const totalGames = result.cells.reduce((sum, cell) => sum + cell.seedCount, 0);
  const allGreen = result.cells.reduce((sum, cell) => sum + cell.demonstration.allGreen, 0);
  process.stdout.write(`sim: ${totalGames} games in ${elapsed}s — demonstration all-green in ${allGreen}/${totalGames}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`sim FAILED: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
