/**
 * Seeded matrix runner (spec §8): {Classic, Quick, Blitz} × {2, 3, 4, 6}
 * players × N seeds per cell, profiles seated in fixed rotation.
 *
 * Seeds derive deterministically from (mode, playerCount, gameIndex) via a
 * splitmix-style hash, so the full matrix regenerates exactly from the
 * seed count alone (the report's regeneration contract). Every game runs
 * through the §17.3 demonstration driver; aggregation adds per-cell
 * statistics and rolls the demonstration counters up per cell.
 */
import { MODES, type ModeId } from '../../src/lib/game/board-v1';
import { runSimulatedGame } from './driver';
import { computeMetrics, CASH_CAUSES, type CashCause, type EliminationCause, type GameMetrics } from './metrics';

export const MATRIX_MODES: readonly ModeId[] = ['CLASSIC', 'QUICK', 'BLITZ'];
export const MATRIX_PLAYER_COUNTS: readonly number[] = [2, 3, 4, 6];

/** A uniform 32-bit scramble (splitmix32 finalizer). */
function hash32(x: number): number {
  let h = x | 0;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad);
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97);
  return (h ^ (h >>> 15)) >>> 0;
}

/** The seed for one game of the matrix — pure in (mode, players, index). */
export function seedForGame(mode: ModeId, playerCount: number, gameIndex: number): number {
  const modeIndex = MATRIX_MODES.indexOf(mode);
  return hash32(
    Math.imul(gameIndex + 1, 0x9e3779b1) ^
      Math.imul(playerCount, 0x85ebca6b) ^
      Math.imul(modeIndex + 1, 0xc2b2ae35),
  );
}

export interface SummaryStats {
  readonly mean: number;
  readonly p50: number;
  readonly p90: number;
}

/** Nearest-rank quantile on the raw samples (p50 → ceil(0.5n), 1-based). */
export function summarize(samples: readonly number[]): SummaryStats {
  if (samples.length === 0) return { mean: 0, p50: 0, p90: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number): number => {
    const index = Math.min(Math.max(Math.ceil(q * sorted.length) - 1, 0), sorted.length - 1);
    return sorted[index] as number;
  };
  const total = samples.reduce((sum, value) => sum + value, 0);
  return { mean: total / samples.length, p50: at(0.5), p90: at(0.9) };
}

function zeroCauses(): Record<CashCause, number> {
  return { RENT: 0, TAX_MUNICIPAL_LEVY: 0, TAX_ASSESSMENT_OFFICE: 0, SERVICE: 0, CARD: 0 };
}

function zeroEliminations(): Record<EliminationCause, number> {
  return { RENT: 0, TAX: 0, SERVICE: 0, CARD: 0, VOLUNTARY: 0, UNKNOWN: 0 };
}

export interface CellDemonstration {
  /** §17.3(a) rejected unauthorized-actor probes. */
  readonly unauthorizedActorRejections: number;
  /** §17.3(b) rejected stale-version probes. */
  readonly staleVersionRejections: number;
  /** §17.3(c) idempotent duplicate resubmissions (applied exactly once). */
  readonly idempotentReplays: number;
  /** §17.3(d) games whose replay refolded to the identical state hash. */
  readonly replayVerified: number;
  /** Games where all four assertions were green. */
  readonly allGreen: number;
  readonly games: number;
}

export interface CellSummary {
  readonly mode: ModeId;
  readonly playerCount: number;
  readonly seedCount: number;
  readonly rounds: SummaryStats;
  readonly appliedCommands: SummaryStats;
  readonly endedBy: Record<string, number>;
  /** Mean eliminations per game (bankruptcy frequency). */
  readonly bankruptciesPerGame: number;
  readonly gamesWithBankruptcy: number;
  readonly landmarkDrivenEliminations: number;
  readonly eliminationsByCause: Record<EliminationCause, number>;
  readonly meanPropertiesAcquiredPerPlayer: number;
  readonly completedDistrictsPerGame: number;
  readonly shareGamesWithCompletedDistrict: number;
  readonly winnerHeldCompleteDistrictShare: number;
  readonly landmarksPerGame: number;
  /** First seat's share of wins (H3). */
  readonly firstSeatWinRate: number;
  readonly cashOutByCause: Record<CashCause, number>;
  readonly tradesOfferedPerGame: number;
  readonly tradesAcceptedPerGame: number;
  readonly tradesCounteredPerGame: number;
  readonly upgradesBuiltPerGame: number;
  readonly shareDecidedBeforeTradeOrUpgrade: number;
  readonly demonstration: CellDemonstration;
  /** The per-game records — retained for report generation and tests. */
  readonly games: readonly GameMetrics[];
}

/** Run one matrix cell: `seedCount` complete games, every one demonstrated. */
export async function runCell(
  mode: ModeId,
  playerCount: number,
  seedCount: number,
  onProgress?: (completed: number, total: number) => void,
): Promise<CellSummary> {
  const rounds: number[] = [];
  const commands: number[] = [];
  const endedBy: Record<string, number> = {};
  const cashOut = zeroCauses();
  const eliminations = zeroEliminations();
  const demonstration = {
    unauthorizedActorRejections: 0,
    staleVersionRejections: 0,
    idempotentReplays: 0,
    replayVerified: 0,
    allGreen: 0,
    games: seedCount,
  };

  let bankruptcies = 0;
  let gamesWithBankruptcy = 0;
  let landmarkDriven = 0;
  let propertySum = 0;
  let districtSum = 0;
  let gamesWithDistrict = 0;
  let winnerWithDistrict = 0;
  let firstSeatWins = 0;
  let tradesOffered = 0;
  let tradesAccepted = 0;
  let tradesCountered = 0;
  let upgradesBuilt = 0;
  let decidedBefore = 0;
  const gameRecords: GameMetrics[] = [];

  for (let index = 0; index < seedCount; index++) {
    const seed = seedForGame(mode, playerCount, index);
    const playerIds: string[] = [];
    for (let seat = 0; seat < playerCount; seat++) playerIds.push(`p${seat + 1}`);
    const result = await runSimulatedGame({
      gameId: `sim-${mode.toLowerCase()}-${playerCount}p-${index}`,
      seed,
      mode,
      playerIds,
    });
    const metrics = computeMetrics(
      { seed, mode, playerCount },
      result.events,
      result.finalState,
      result.appliedCommands,
    );
    gameRecords.push(metrics);

    rounds.push(metrics.rounds);
    commands.push(metrics.appliedCommands);
    endedBy[metrics.endedBy] = (endedBy[metrics.endedBy] ?? 0) + 1;
    for (const cause of CASH_CAUSES) cashOut[cause] += metrics.cashOutByCause[cause];
    for (const cause of Object.keys(metrics.eliminationCauses) as EliminationCause[]) {
      eliminations[cause] += metrics.eliminationCauses[cause];
    }
    bankruptcies += metrics.bankruptcies;
    if (metrics.bankruptcies > 0) gamesWithBankruptcy += 1;
    landmarkDriven += metrics.landmarkDrivenBankruptcies;
    propertySum += metrics.meanPropertiesAcquiredPerPlayer;
    districtSum += metrics.completedDistrictsEver;
    if (metrics.hadCompletedDistrict) gamesWithDistrict += 1;
    if (metrics.winnerHeldCompleteDistrict) winnerWithDistrict += 1;
    if (metrics.seat0Won) firstSeatWins += 1;
    tradesOffered += metrics.tradesOffered;
    tradesAccepted += metrics.tradesAccepted;
    tradesCountered += metrics.tradesCountered;
    upgradesBuilt += metrics.upgradesBuilt;
    if (metrics.decidedBeforeTradeOrUpgrade) decidedBefore += 1;

    demonstration.unauthorizedActorRejections += result.demonstration.unauthorizedActorRejections;
    demonstration.staleVersionRejections += result.demonstration.staleVersionRejections;
    demonstration.idempotentReplays += result.demonstration.idempotentReplays;
    if (result.demonstration.replayVerified) demonstration.replayVerified += 1;
    if (result.demonstration.allGreen) demonstration.allGreen += 1;

    if (onProgress) onProgress(index + 1, seedCount);
  }

  return {
    mode,
    playerCount,
    seedCount,
    rounds: summarize(rounds),
    appliedCommands: summarize(commands),
    endedBy,
    bankruptciesPerGame: seedCount > 0 ? bankruptcies / seedCount : 0,
    gamesWithBankruptcy,
    landmarkDrivenEliminations: landmarkDriven,
    eliminationsByCause: eliminations,
    meanPropertiesAcquiredPerPlayer: seedCount > 0 ? propertySum / seedCount : 0,
    completedDistrictsPerGame: seedCount > 0 ? districtSum / seedCount : 0,
    shareGamesWithCompletedDistrict: seedCount > 0 ? gamesWithDistrict / seedCount : 0,
    winnerHeldCompleteDistrictShare: seedCount > 0 ? winnerWithDistrict / seedCount : 0,
    landmarksPerGame: gameRecords.reduce((sum, m) => sum + m.landmarksEver, 0) / Math.max(seedCount, 1),
    firstSeatWinRate: seedCount > 0 ? firstSeatWins / seedCount : 0,
    cashOutByCause: cashOut,
    tradesOfferedPerGame: seedCount > 0 ? tradesOffered / seedCount : 0,
    tradesAcceptedPerGame: seedCount > 0 ? tradesAccepted / seedCount : 0,
    tradesCounteredPerGame: seedCount > 0 ? tradesCountered / seedCount : 0,
    upgradesBuiltPerGame: seedCount > 0 ? upgradesBuilt / seedCount : 0,
    shareDecidedBeforeTradeOrUpgrade: seedCount > 0 ? decidedBefore / seedCount : 0,
    demonstration,
    games: gameRecords,
  };
}

export interface MatrixResult {
  readonly seedCount: number;
  readonly cells: readonly CellSummary[];
  readonly rulesVersion: number;
  readonly generatedByCommand: string;
}

/** Run the full matrix (or a flag-selected slice of it). */
export async function runMatrix(options: {
  readonly modes?: readonly ModeId[];
  readonly playerCounts?: readonly number[];
  readonly seedCount: number;
  readonly onProgress?: (cellIndex: number, totalCells: number, mode: ModeId, players: number, completed: number) => void;
}): Promise<MatrixResult> {
  const modes = options.modes ?? MATRIX_MODES;
  const playerCounts = options.playerCounts ?? MATRIX_PLAYER_COUNTS;
  const cells: CellSummary[] = [];
  const totalCells = modes.length * playerCounts.length;
  let cellIndex = 0;
  for (const mode of modes) {
    if (MODES[mode] === undefined) throw new Error(`unknown mode ${mode}`);
    for (const playerCount of playerCounts) {
      const cell = await runCell(mode, playerCount, options.seedCount, (completed, total) => {
        if (options.onProgress) options.onProgress(cellIndex, totalCells, mode, playerCount, Math.min(completed, total));
      });
      cells.push(cell);
      cellIndex += 1;
    }
  }
  return {
    seedCount: options.seedCount,
    cells,
    rulesVersion: 1,
    generatedByCommand: `npm run sim -- --seeds=${options.seedCount}`,
  };
}
