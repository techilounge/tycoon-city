/**
 * Report generation (spec §8): MatrixResult → docs/ECONOMY.md.
 *
 * Pure string assembly — no I/O here. Formatting is deliberately
 * deterministic (fixed decimal places, manual thousands separators, no
 * locale-dependent calls) so the committed report regenerates
 * byte-for-byte from seeds alone. Hypothesis verdicts are COMPUTED from
 * the matrix with the thresholds stated inline; nothing is asserted
 * without a number behind it.
 */
import type { ModeId } from '../../src/lib/game/board-v1';
import { MODES } from '../../src/lib/game/board-v1';
import type { MatrixResult } from './matrix';
import { CASH_CAUSES, type CashCause } from './metrics';

const comma = (value: number): string => Math.round(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const usd = (value: number): string => `$${comma(value)}`;
const pct = (share: number): string => `${(100 * share).toFixed(1)}%`;
const num1 = (value: number): string => value.toFixed(1);
const num2 = (value: number): string => value.toFixed(2);

function modeLabel(mode: ModeId): string {
  return mode.charAt(0) + mode.slice(1).toLowerCase();
}

function cellOrder(result: MatrixResult): string {
  return result.cells.map((cell) => `${cell.mode}-${cell.playerCount}`).join(', ');
}

// --- Hypothesis verdicts (thresholds stated in the report text).

export interface HypothesisVerdict {
  readonly id: 'H1' | 'H2' | 'H3' | 'H4';
  readonly statement: string;
  readonly verdict: 'CONFIRMED' | 'OVERTURNED' | 'INCONCLUSIVE';
  readonly evidence: string;
}

export function evaluateHypotheses(result: MatrixResult): HypothesisVerdict[] {
  const cells = result.cells;
  const totalEliminations = cells.reduce(
    (sum, cell) => sum + Object.values(cell.eliminationsByCause).reduce((a, b) => a + b, 0),
    0,
  );
  const totalLandmarkDriven = cells.reduce((sum, cell) => sum + cell.landmarkDrivenEliminations, 0);
  const totalGames = cells.reduce((sum, cell) => sum + cell.seedCount, 0);
  const winnerDistrictGames = cells.reduce(
    (sum, cell) => sum + cell.winnerHeldCompleteDistrictShare * cell.seedCount,
    0,
  );

  // H1 — landmark-driven bankruptcies rare; districts decisive.
  const h1Share = totalEliminations > 0 ? totalLandmarkDriven / totalEliminations : 0;
  const h1: HypothesisVerdict = {
    id: 'H1',
    statement:
      'With the ×20 landmark rent multiplier, landmark-driven bankruptcies are rare (< 5% of eliminations) while completed districts stay decisive.',
    verdict: totalEliminations === 0 ? 'INCONCLUSIVE' : h1Share < 0.05 ? 'CONFIRMED' : 'OVERTURNED',
    evidence:
      totalEliminations === 0
        ? 'No eliminations occurred in any cell, so the share is undefined.'
        : `Landmark-driven: ${totalLandmarkDriven} of ${totalEliminations} eliminations across all cells (${pct(h1Share)}; threshold < 5%). Winners held a complete district at the end in ${Math.round(winnerDistrictGames)} of ${totalGames} games (${pct(winnerDistrictGames / Math.max(totalGames, 1))}).`,
  };

  // H2 — the Municipal Levy is the largest single cash-out cause; the Blitz
  // cap-binding check shows whether p90 lengths are blowing out.
  const totalCashOut = cells.reduce(
    (sum, cell) => sum + CASH_CAUSES.reduce((acc, cause) => acc + cell.cashOutByCause[cause], 0),
    0,
  );
  const levyTotal = cells.reduce((sum, cell) => sum + cell.cashOutByCause.TAX_MUNICIPAL_LEVY, 0);
  const causeTotals = CASH_CAUSES.map((cause) => ({
    cause,
    total: cells.reduce((sum, cell) => sum + cell.cashOutByCause[cause], 0),
  })).sort((a, b) => b.total - a.total);
  const largest = causeTotals[0];
  const blitzCells = cells.filter((cell) => cell.mode === 'BLITZ');
  const blitzCapBound = blitzCells.filter((cell) => cell.rounds.p90 >= MODES.BLITZ.roundCap);
  const h2: HypothesisVerdict = {
    id: 'H2',
    statement:
      'The 8% Municipal Levy is the largest single-cause cash-out event in mid-game; if p90 match lengths blow out in Blitz, the levy becomes flat or capped first.',
    verdict: totalCashOut === 0 ? 'INCONCLUSIVE' : largest.cause === 'TAX_MUNICIPAL_LEVY' ? 'CONFIRMED' : 'OVERTURNED',
    evidence:
      totalCashOut === 0
        ? 'No cash-out events occurred in any cell.'
        : `Levy share of all cash-out: ${pct(levyTotal / totalCashOut)} (${usd(levyTotal)} of ${usd(totalCashOut)}). Largest single cause overall: ${largest.cause} (${pct(largest.total / totalCashOut)}). Blitz p90 rounds at or above the ${MODES.BLITZ.roundCap}-round cap: ${blitzCapBound.length} of ${blitzCells.length} Blitz cells.`,
  };

  // H3 — first-player advantage under 10 percentage points at 3–4 players.
  const h3Cells = cells.filter((cell) => cell.playerCount === 3 || cell.playerCount === 4);
  const worst = h3Cells.reduce<{ cell: (typeof h3Cells)[number] | null; gap: number }>((max, candidate) => {
    const gap = candidate.firstSeatWinRate - 1 / candidate.playerCount;
    return gap > max.gap ? { cell: candidate, gap } : max;
  }, { cell: null, gap: Number.NEGATIVE_INFINITY });
  const h3: HypothesisVerdict = {
    id: 'H3',
    statement: 'First-player advantage stays under 10 percentage points of win rate at 3–4 players.',
    verdict: worst.cell === null ? 'INCONCLUSIVE' : worst.gap < 0.1 ? 'CONFIRMED' : 'OVERTURNED',
    evidence:
      worst.cell === null
        ? 'No 3–4 player cells were simulated.'
        : `Worst gap: ${modeLabel(worst.cell.mode)} ${worst.cell.playerCount}p — seat-1 win rate ${pct(worst.cell.firstSeatWinRate)} vs even share ${pct(1 / worst.cell.playerCount)} (gap ${pct(worst.gap)}; threshold < 10pp).`,
  };

  // H4 — a nontrivial share of 6-player games end by round cap.
  const sixPlayerCells = cells.filter((cell) => cell.playerCount === 6);
  const capGames = sixPlayerCells.reduce((sum, cell) => sum + (cell.endedBy.ROUND_CAP ?? 0), 0);
  const sixGames = sixPlayerCells.reduce((sum, cell) => sum + cell.seedCount, 0);
  const capShare = sixGames > 0 ? capGames / sixGames : 0;
  const h4: HypothesisVerdict = {
    id: 'H4',
    statement: 'A nontrivial share (≥ 20% — analysis convention) of 6-player games end by round cap rather than target net worth.',
    verdict: sixGames === 0 ? 'INCONCLUSIVE' : capShare >= 0.2 ? 'CONFIRMED' : 'OVERTURNED',
    evidence:
      sixGames === 0
        ? 'No 6-player cells were simulated.'
        : `ROUND_CAP endings: ${capGames} of ${sixGames} six-player games (${pct(capShare)}; threshold ≥ 20%).`,
  };

  return [h1, h2, h3, h4];
}

// --- Tables.

function matchLengthTable(result: MatrixResult): string {
  const rows = result.cells.map(
    (cell) =>
      `| ${modeLabel(cell.mode)} | ${cell.playerCount} | ${cell.seedCount} | ${num1(cell.rounds.p50)} | ${num1(cell.rounds.p90)} | ${comma(cell.appliedCommands.p50)} | ${comma(cell.appliedCommands.p90)} | ${cell.endedBy.LAST_SOLVENT ?? 0} | ${cell.endedBy.NET_WORTH_TARGET ?? 0} | ${cell.endedBy.ROUND_CAP ?? 0} |`,
  );
  return [
    '| Mode | Players | Seeds | p50 rounds | p90 rounds | p50 cmds | p90 cmds | Last-solvent | Net-worth target | Round cap |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...rows,
  ].join('\n');
}

function bankruptcyTable(result: MatrixResult): string {
  const rows = result.cells.map((cell) => {
    const total = Object.values(cell.eliminationsByCause).reduce((a, b) => a + b, 0);
    return `| ${modeLabel(cell.mode)} | ${cell.playerCount} | ${num2(cell.bankruptciesPerGame)} | ${pct(cell.gamesWithBankruptcy / Math.max(cell.seedCount, 1))} | ${cell.landmarkDrivenEliminations} | ${cell.eliminationsByCause.RENT} | ${cell.eliminationsByCause.TAX} | ${cell.eliminationsByCause.SERVICE} | ${cell.eliminationsByCause.CARD} | ${cell.eliminationsByCause.VOLUNTARY} | ${total} |`;
  });
  return [
    '| Mode | Players | Elim/game | Games with ≥1 elim | Landmark-driven | Rent | Tax | Service | Card | Voluntary | Total elims |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows,
  ].join('\n');
}

function cashOutTable(result: MatrixResult): string {
  const rows = result.cells.map((cell) => {
    const per = (cause: CashCause): string => usd(cell.cashOutByCause[cause] / Math.max(cell.seedCount, 1));
    return `| ${modeLabel(cell.mode)} | ${cell.playerCount} | ${per('RENT')} | ${per('TAX_MUNICIPAL_LEVY')} | ${per('TAX_ASSESSMENT_OFFICE')} | ${per('SERVICE')} | ${per('CARD')} |`;
  });
  return [
    '| Mode | Players | Rent/game | Levy/game | Assessment/game | Services/game | Cards/game |',
    '|---|---|---|---|---|---|---|',
    ...rows,
  ].join('\n');
}

function developmentTable(result: MatrixResult): string {
  const rows = result.cells.map(
    (cell) =>
      `| ${modeLabel(cell.mode)} | ${cell.playerCount} | ${num1(cell.upgradesBuiltPerGame)} | ${num2(cell.landmarksPerGame)} | ${pct(cell.shareGamesWithCompletedDistrict)} | ${pct(cell.winnerHeldCompleteDistrictShare)} | ${num1(cell.tradesOfferedPerGame)} | ${num1(cell.tradesAcceptedPerGame)} | ${num1(cell.tradesCounteredPerGame)} | ${num1(cell.meanPropertiesAcquiredPerPlayer)} | ${pct(cell.shareDecidedBeforeTradeOrUpgrade)} |`,
  );
  return [
    '| Mode | Players | Upgrades built/game | Landmarks/game | Games w/ completed district | Winner held district | Trades offered | Accepted | Countered | Mean props/player | Decided before trade/upgrade |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows,
  ].join('\n');
}

function firstPlayerTable(result: MatrixResult): string {
  const rows = result.cells.map(
    (cell) =>
      `| ${modeLabel(cell.mode)} | ${cell.playerCount} | ${pct(cell.firstSeatWinRate)} | ${pct(1 / cell.playerCount)} | ${pct(cell.firstSeatWinRate - 1 / cell.playerCount)} |`,
  );
  return ['| Mode | Players | Seat-1 win rate | Even share | Gap |', '|---|---|---|---|---|', ...rows].join('\n');
}

function demonstrationTable(result: MatrixResult): string {
  const rows = result.cells.map(
    (cell) =>
      `| ${modeLabel(cell.mode)} | ${cell.playerCount} | ${cell.seedCount} | ${comma(cell.demonstration.unauthorizedActorRejections)} | ${comma(cell.demonstration.staleVersionRejections)} | ${comma(cell.demonstration.idempotentReplays)} | ${cell.demonstration.replayVerified} | ${cell.demonstration.allGreen} |`,
  );
  return [
    '| Mode | Players | Games | (a) unauthorized rejected | (b) stale version rejected | (c) duplicates applied once | (d) replays identical | All green |',
    '|---|---|---|---|---|---|---|---|',
    ...rows,
  ].join('\n');
}

// --- The document.

export function renderEconomyReport(result: MatrixResult): string {
  const verdicts = evaluateHypotheses(result);
  const totalGames = result.cells.reduce((sum, cell) => sum + cell.seedCount, 0);
  const demo = result.cells.reduce(
    (acc, cell) => ({
      unauthorized: acc.unauthorized + cell.demonstration.unauthorizedActorRejections,
      stale: acc.stale + cell.demonstration.staleVersionRejections,
      idempotent: acc.idempotent + cell.demonstration.idempotentReplays,
      replayVerified: acc.replayVerified + cell.demonstration.replayVerified,
      allGreen: acc.allGreen + cell.demonstration.allGreen,
    }),
    { unauthorized: 0, stale: 0, idempotent: 0, replayVerified: 0, allGreen: 0 },
  );

  return `# Economy Simulation Report (Phase 1, rules-v${result.rulesVersion})

**Generated by:** \`${result.generatedByCommand}\` (deterministic — rerunning reproduces every number in this document from seeds alone; no wall clock, no ambient randomness). See [Reproduction](#reproduction).

**All economy values are PROVISIONAL (spec §8, Decision D-3).** This report is evidence for the owner's retuning decision — it changes nothing by itself. A data-only retune would touch \`src/lib/game/board-v1.ts\` / \`src/lib/game/rules-v1.ts\` constants and \`docs/RULES.md\` in one PR (locked decision 4), never engine logic.

## Methodology

A headless harness (\`tools/sim/\`) drives **complete games** through the production engine and the production \`LocalCommandSink\` — the exact command path the hot-seat UI uses. No engine code is stubbed or re-implemented; the harness owns only strategy decisions and command envelopes.

- **Matrix:** {Classic, Quick, Blitz} × {2, 3, 4, 6} players × ${result.seedCount} seeds per cell (spec §8). Game seeds derive deterministically from (mode, player count, game index) — \`seedForGame\` in \`tools/sim/matrix.ts\`.
- **Profiles (fixed seat rotation CONSERVATIVE → AGGRESSIVE → MIXED → RANDOM_WALK, repeating):**
  - **Conservative** — buys only when cash > 2× list price; builds only with a 3×-cost cash reserve; bids at most 50% of list price; accepts a sale offer at ≤ 60% of list with a 2× cash buffer.
  - **Aggressive** — buys anything affordable; bids to 120% of list price; builds whenever affordable; accepts space offers at up to 160% of list.
  - **Mixed** — buys if price < 40% of cash; bids to 90% of list; builds with a 2× reserve; accepts at list price.
  - **Random-Walk** — valid random commands (50% buy chance, 40% bid chance with a random ceiling, one random legal management action 40% of turns, occasional HOLD and trade counters) for invariant stress.
- **Metric definitions:** match length in commands counts submissions that **applied** (probe rejections and idempotent duplicates never count). "Landmark-driven" elimination = the open debt at bankruptcy was **rent** owed on a level-4 space at debt-entry time. "A trade occurred" = an **accepted** trade (assets moved). Cash-out by cause sums every dollar that left a wallet, attributed at charge time (the Municipal Levy is split from the flat Assessment Office; settled debts carry their entry-time cause).
- **Quantiles:** nearest-rank on raw per-game samples (p50, p90). Means are arithmetic.

## Match length and endings

${matchLengthTable(result)}

## Bankruptcy

${bankruptcyTable(result)}

## Cash-out by cause (per game, mean)

${cashOutTable(result)}

## Development, districts, and trades

${developmentTable(result)}

## First-player advantage (seat 1 vs even share)

${firstPlayerTable(result)}

## Hypotheses — H1 to H4 (spec §8)

Verdicts are computed from the tables above with the thresholds stated in each row. These numbers are the first measurement of rules-v1 under strategic pressure.

${verdicts
  .map((v) => `### ${v.id} — ${v.verdict}\n\n> ${v.statement}\n\n${v.evidence}`)
  .join('\n\n')}

## Multiplayer-contract demonstration (spec §17.3)

Every simulated game above is simultaneously a **headless multiplayer-contract demonstration**: simulated actors submit through the production \`LocalCommandSink\`, and the driver interleaves three probe commands at every roll decision point plus a full-game replay check. Assertions, per spec §17.3:

- **(a) Actor authorization** — a non-active live player's \`ROLL\` is rejected with \`NOT_AUTHORIZED\` and the state hash is unchanged before and after. This is the \`canAct(state, command)\` pure function the Phase 2 server reuses server-side.
- **(b) Optimistic concurrency** — a command composed against \`expectedVersion = state.version − 1\` is rejected with \`VERSION_CONFLICT\`, state unchanged. The exact check a Phase 2 server applies to every client submission.
- **(c) Idempotency** — resubmitting a processed \`commandId\` verbatim returns ok with \`applied: false\` and the stored events; state hash unchanged. Duplicate delivery (a Phase 2 transport fact of life) applies exactly once.
- **(d) Replay** — after the game ends, the entire ordered submission log (probes included) is refolded from the initial state; the refolded state hash must equal the live final hash and the applied-command count must match.

${demonstrationTable(result)}

Across all ${totalGames} games: **${comma(demo.unauthorized)}** authorization rejections, **${comma(demo.stale)}** stale-version rejections, **${comma(demo.idempotent)}** idempotent duplicate applications (all no-ops), and **${demo.replayVerified}/${totalGames}** games replaying to an identical state hash — **${demo.allGreen}/${totalGames} fully green**. A failing assertion throws immediately, so these numbers cannot silently hide a red probe.

## Reproduction

\`\`\`bash
npm run sim -- --seeds=${result.seedCount} --md=docs/ECONOMY.md   # this document (also writes JSON to tools/sim/results/)
npm run sim -- --seeds=20                                        # the CI smoke matrix
npm run sim -- --modes=BLITZ --players=2,3 --seeds=50            # any slice
\`\`\`

Seeds are pure functions of (mode, player count, game index) — \`seedForGame\`. The 500-seed full matrix is a local/scripted job (spec §14); CI runs the 20-seed smoke per cell inside the normal test suite. Cell order key for tooling that consumes the JSON: \`${cellOrder(result)}\`.
`;
}
