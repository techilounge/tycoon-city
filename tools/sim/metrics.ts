/**
 * Per-game metrics extraction (spec §8).
 *
 * Pure function over a finished simulation: the stamped event log plus the
 * driver's applied-command count produce one GameMetrics record. The event
 * log is the record — metrics are derived exclusively from events, so the
 * same inputs always regenerate the same numbers (the report's
 * "regenerates exactly from seeds" contract, spec §8 / §17.3).
 *
 * Definitions (documented in docs/ECONOMY.md):
 * - Match length in commands = submissions that APPLIED (probes and
 *   idempotent duplicates never count).
 * - "Landmark-driven" elimination = the open debt at PLAYER_BANKRUPT was
 *   RENT owed on a space at level ≥ 4 at debt-entry time. Levels are
 *   tracked through the log: UPGRADE_BUILT / UPGRADE_SOLD carry the
 *   resulting level (development.ts), and a bank-creditor waterfall
 *   removes buildings from transferred spaces (spec §7 step 4).
 * - "A trade occurred" = an accepted trade (assets moved); "an upgrade
 *   occurred" = a built level (UPGRADE_BUILT).
 * - Cash-by-cause: the single charge seam (economy.ts) pushes receipt
 *   events (RENT_PAID / TAX_PAID / SERVICE_CHARGED) only on the paid
 *   path, so a settled debt is counted once from DEBT_SETTLED with the
 *   cause captured at DEBT_ENTERED. CARD_EFFECT_APPLIED fires on BOTH
 *   paths (it is the card payment's receipt), so CARD debts add nothing
 *   at settlement.
 * - Cash-out attribution ignores who received: the levy is a bank charge,
 *   rent/service go to players — the metrics measure cash leaving a
 *   wallet, per the spec's "cash-out" language.
 */
import { BOARD_SPACES, DISTRICTS, isPurchasable, type PurchasableSpace } from '../../src/lib/game/board-v1';
import { BANK_ID } from '../../src/lib/game/types';
import type { DebtReason, GameState, PlayerId, SpaceId } from '../../src/lib/game/types';
import type { AnyGameEvent } from '../../src/lib/game/events';

/** Every cash-out cause, with the Municipal Levy split out of TAX. */
export type CashCause = 'RENT' | 'TAX_MUNICIPAL_LEVY' | 'TAX_ASSESSMENT_OFFICE' | 'SERVICE' | 'CARD';

export const CASH_CAUSES: readonly CashCause[] = [
  'RENT',
  'TAX_MUNICIPAL_LEVY',
  'TAX_ASSESSMENT_OFFICE',
  'SERVICE',
  'CARD',
];

export type EliminationCause = DebtReason | 'VOLUNTARY' | 'UNKNOWN';

export interface GameMetrics {
  readonly seed: number;
  readonly mode: string;
  readonly playerCount: number;
  /** Final round ordinal; the ROUND_CAP path ends at the cap. */
  readonly rounds: number;
  readonly appliedCommands: number;
  readonly endedBy: string;
  readonly winnerIds: readonly PlayerId[];
  /** Did the first seat win (H3 first-player advantage)? */
  readonly seat0Won: boolean;
  readonly bankruptcies: number;
  /** Eliminations whose terminal rent was owed on a level-4 space (H1). */
  readonly landmarkDrivenBankruptcies: number;
  readonly eliminationCauses: Readonly<Record<EliminationCause, number>>;
  /** PROPERTY_PURCHASED events per player, averaged (mean per player). */
  readonly meanPropertiesAcquiredPerPlayer: number;
  /** Districts ever held complete by one owner (count of district ids). */
  readonly completedDistrictsEver: number;
  /** Any player held a complete district at some point. */
  readonly hadCompletedDistrict: boolean;
  /** The winner held a complete district at game end (H1 "decisiveness"). */
  readonly winnerHeldCompleteDistrict: boolean;
  /** Spaces that ever reached level 4 (the landmark). */
  readonly landmarksEver: number;
  readonly cashOutByCause: Readonly<Record<CashCause, number>>;
  readonly tradesOffered: number;
  readonly tradesAccepted: number;
  readonly tradesCountered: number;
  readonly upgradesBuilt: number;
  /** Game decided with neither an accepted trade nor any built level. */
  readonly decidedBeforeTradeOrUpgrade: boolean;
}

interface OpenDebtInfo {
  readonly reason: DebtReason;
  /** CashCause for settlement attribution (levy vs office split for TAX). */
  readonly cause: CashCause;
  /** The rent space (debtor's landing position) for RENT-reason debts. */
  readonly rentSpaceId: SpaceId | null;
}

function emptyCauses(): Record<CashCause, number> {
  return { RENT: 0, TAX_MUNICIPAL_LEVY: 0, TAX_ASSESSMENT_OFFICE: 0, SERVICE: 0, CARD: 0 };
}

function emptyEliminationCauses(): Record<EliminationCause, number> {
  return { RENT: 0, TAX: 0, SERVICE: 0, CARD: 0, VOLUNTARY: 0, UNKNOWN: 0 };
}

/** Derive every metric for one finished game. */
export function computeMetrics(
  input: { readonly seed: number; readonly mode: string; readonly playerCount: number },
  events: readonly AnyGameEvent[],
  finalState: GameState,
  appliedCommands: number,
): GameMetrics {
  const cashOut = emptyCauses();
  const eliminationCauses = emptyEliminationCauses();
  const openDebts = new Map<PlayerId, OpenDebtInfo>();
  const positions = new Map<PlayerId, number>();
  const levels = new Map<SpaceId, number>();
  const owners = new Map<SpaceId, PlayerId>();
  const completedDistricts = new Set<string>();
  const landmarkSpaces = new Set<SpaceId>();
  const purchasesByPlayer = new Map<PlayerId, number>();

  let playerIds: readonly PlayerId[] = finalState.players.map((player) => player.id);
  let bankruptcies = 0;
  let landmarkDriven = 0;
  let tradesOffered = 0;
  let tradesAccepted = 0;
  let tradesCountered = 0;
  let upgradesBuilt = 0;
  let endedBy = 'UNKNOWN';
  let winnerIds: readonly PlayerId[] = [];

  const noteDistrictCompletion = (): void => {
    for (const district of DISTRICTS) {
      const first = owners.get(district.spaceIds[0]);
      if (first === undefined) continue;
      const complete = district.spaceIds.every((spaceId) => owners.get(spaceId) === first);
      if (complete) completedDistricts.add(district.id);
    }
  };

  for (const event of events) {
    switch (event.type) {
      case 'GAME_CREATED':
        playerIds = event.payload.playerIds;
        for (const playerId of playerIds) positions.set(playerId, 0);
        break;
      case 'PLAYER_MOVED':
        positions.set(event.payload.playerId, event.payload.to);
        break;
      case 'PROPERTY_PURCHASED':
        owners.set(event.payload.spaceId, event.payload.playerId);
        purchasesByPlayer.set(event.payload.playerId, (purchasesByPlayer.get(event.payload.playerId) ?? 0) + 1);
        noteDistrictCompletion();
        break;
      case 'ASSETS_TRANSFERRED': {
        // Waterfall ownership transfer (spec §7). A bank creditor takes
        // the estate with buildings removed (levels → 0, ownership →
        // bank/unowned); a player creditor takes upgrades intact.
        for (const spaceId of event.payload.spaceIds) {
          if (event.payload.toId !== BANK_ID) continue;
          owners.delete(spaceId);
          levels.set(spaceId, 0);
        }
        break;
      }
      case 'UPGRADE_BUILT':
        levels.set(event.payload.spaceId, event.payload.level);
        upgradesBuilt += 1;
        if (event.payload.level >= 4) landmarkSpaces.add(event.payload.spaceId);
        break;
      case 'UPGRADE_SOLD':
        levels.set(event.payload.spaceId, event.payload.level);
        break;
      case 'RENT_PAID':
        cashOut.RENT += event.payload.amount;
        break;
      case 'TAX_PAID':
        cashOut[event.payload.taxKind === 'MUNICIPAL_LEVY' ? 'TAX_MUNICIPAL_LEVY' : 'TAX_ASSESSMENT_OFFICE'] +=
          event.payload.amount;
        break;
      case 'SERVICE_CHARGED':
        cashOut.SERVICE += event.payload.amount;
        break;
      case 'CARD_EFFECT_APPLIED':
        // Fires on both the paid and debt paths (the receipt for a card
        // payment); DEBT_SETTLED for CARD debts adds nothing.
        if (event.payload.effect.kind === 'PAY') cashOut.CARD += event.payload.effect.amount;
        break;
      case 'DEBT_ENTERED': {
        const { debtorId, reason } = event.payload;
        const position = positions.get(debtorId) ?? 0;
        const landed = BOARD_SPACES[position];
        const cause =
          reason === 'RENT'
            ? 'RENT'
            : reason === 'SERVICE'
              ? 'SERVICE'
              : reason === 'CARD'
                ? 'CARD'
                : landed.kind === 'ASSESSMENT' && landed.taxKind === 'MUNICIPAL_LEVY'
                  ? 'TAX_MUNICIPAL_LEVY'
                  : 'TAX_ASSESSMENT_OFFICE';
        openDebts.set(debtorId, {
          reason,
          cause,
          rentSpaceId: reason === 'RENT' && isPurchasable(landed) ? landed.id : null,
        });
        break;
      }
      case 'DEBT_SETTLED': {
        const info = openDebts.get(event.payload.debtorId);
        if (info && info.cause !== 'CARD') cashOut[info.cause] += event.payload.amount;
        openDebts.delete(event.payload.debtorId);
        break;
      }
      case 'PLAYER_BANKRUPT': {
        const info = openDebts.get(event.payload.playerId);
        bankruptcies += 1;
        if (info) {
          eliminationCauses[info.reason] += 1;
          if (info.reason === 'RENT' && info.rentSpaceId !== null && (levels.get(info.rentSpaceId) ?? 0) >= 4) {
            landmarkDriven += 1;
          }
        } else {
          // Voluntary surrender in TURN_MANAGEMENT (no open debt).
          eliminationCauses.VOLUNTARY += 1;
        }
        openDebts.delete(event.payload.playerId);
        break;
      }
      case 'TRADE_OFFERED':
        tradesOffered += 1;
        break;
      case 'TRADE_ANSWERED':
        if (event.payload.response === 'ACCEPT') tradesAccepted += 1;
        if (event.payload.response === 'COUNTER') tradesCountered += 1;
        break;
      case 'VICTORY_DECIDED':
        endedBy = event.payload.reason;
        winnerIds = event.payload.winnerIds;
        break;
      default:
        break;
    }
  }

  const winnerHeldCompleteDistrict = winnerIds.some(
    (winnerId) =>
      DISTRICTS.some((district) => district.spaceIds.every((spaceId) => finalState.owners[spaceId] === winnerId)),
  );

  return {
    seed: input.seed,
    mode: input.mode,
    playerCount: input.playerCount,
    rounds: finalState.round,
    appliedCommands,
    endedBy,
    winnerIds,
    seat0Won: winnerIds.includes(playerIds[0]),
    bankruptcies,
    landmarkDrivenBankruptcies: landmarkDriven,
    eliminationCauses,
    meanPropertiesAcquiredPerPlayer:
      input.playerCount > 0 ? sumValues(purchasesByPlayer) / input.playerCount : 0,
    completedDistrictsEver: completedDistricts.size,
    hadCompletedDistrict: completedDistricts.size > 0,
    winnerHeldCompleteDistrict,
    landmarksEver: landmarkSpaces.size,
    cashOutByCause: cashOut,
    tradesOffered,
    tradesAccepted,
    tradesCountered,
    upgradesBuilt,
    decidedBeforeTradeOrUpgrade: tradesAccepted === 0 && upgradesBuilt === 0,
  };
}

function sumValues(map: Map<PlayerId, number>): number {
  let total = 0;
  for (const value of map.values()) total += value;
  return total;
}

/** An owned purchasable space list for one player, board order (tests use this). */
export function ownedSpacesOf(state: GameState, playerId: PlayerId): PurchasableSpace[] {
  return BOARD_SPACES.filter(
    (space): space is PurchasableSpace => isPurchasable(space) && state.owners[space.id] === playerId,
  );
}
