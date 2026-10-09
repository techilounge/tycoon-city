/**
 * Rules v1 — every economy formula, single-sourced (spec §8, §9).
 *
 * docs/RULES.md mirrors these tables one row at a time (one test per row in
 * tests/game/rules-board.test.ts pins each value). An economy retune changes
 * THIS file and docs/RULES.md in the same PR — nowhere else. This module is
 * the RULES_VERSION 1 rulebook in code: pure functions and constants only,
 * no state, no clock, no randomness.
 *
 * All prices on board-v1 are multiples of 20, so every derived amount below
 * (rents, upgrade costs, sell-backs, mortgage math) is an integral number of
 * dollars — money stays in whole dollars by construction, not by rounding.
 */

import type { MoveDirection } from './events';
import type { SpaceId } from './types';
import type { AssessmentSpace, BoardSpace, CardMoveEffect } from './board-v1';

/** Rent multiplier per upgrade level, indexed 0–4 (spec §8). Level 4 is the
 *  landmark; its ×20 is Decision D-3, flagged provisional pending PR 9. */
export const LEVEL_RENT_MULTIPLIERS: readonly [1, 3, 7, 15, 20] = [1, 3, 7, 15, 20];

/** Highest upgrade level a property can hold (the landmark). */
export const MAX_UPGRADE_LEVEL = 4;

/** Base rent: 10% of list price (spec §8). */
export const BASE_RENT_RATE = 0.1;

/** Rent doubles when the owner holds every property in the district (spec §8). */
export const DISTRICT_COMPLETE_MULTIPLIER = 2;

/** Building an upgrade level costs 50% of the space's list price (spec §8). */
export const UPGRADE_COST_RATE = 0.5;

/** Selling an upgrade level back returns 50% of the price originally paid for it (spec §7, §9). */
export const UPGRADE_SELL_BACK_RATE = 0.5;

/** Taking a mortgage pays 50% of the space's list price (spec §8). */
export const MORTGAGE_PAYOUT_RATE = 0.5;

/** A mortgage's liability against net worth: 50% of list price (spec §9). */
export const MORTGAGE_LIABILITY_RATE = 0.5;

/** Lifting a mortgage costs 110% of the space's list price (spec §8). */
export const UNMORTGAGE_COST_RATE = 1.1;

/** City services charge 6× the dice total, or 18× when one owner holds both (spec §8). */
export const SERVICE_MULTIPLIER_SINGLE = 6;
export const SERVICE_MULTIPLIER_BOTH = 18;

/** Round to the nearest $5 — the granularity of computed charges (spec §8 levy). */
export function round5(amount: number): number {
  return Math.round(amount / 5) * 5;
}

/** Round DOWN to a multiple of $5 — the Rent Holiday's halving rule (spec §4). */
export function floor5(amount: number): number {
  return Math.floor(amount / 5) * 5;
}

/** Base rent is 10% of the space's list price, before multipliers (spec §8). */
export function baseRent(listPrice: number): number {
  return listPrice * BASE_RENT_RATE;
}

export interface RentInput {
  readonly listPrice: number;
  /** Built upgrade level, 0 (none) through 4 (landmark). */
  readonly level: number;
  /** True when the owner holds all three properties of the district. */
  readonly districtComplete: boolean;
}

/**
 * Rent for one space: base rent × level multiplier, ×2 for a completed
 * district (spec §8). Hubs and services do not use this formula — they have
 * their own (hubRent, serviceCharge). A mortgaged property collects no rent;
 * that gate is state-level resolution logic (PR 5), not arithmetic.
 */
export function rentFor({ listPrice, level, districtComplete }: RentInput): number {
  if (!Number.isInteger(level) || level < 0 || level > MAX_UPGRADE_LEVEL) {
    throw new Error(`rules-v1: upgrade level must be an integer 0–${MAX_UPGRADE_LEVEL}, got ${level}`);
  }
  return baseRent(listPrice) * LEVEL_RENT_MULTIPLIERS[level] * (districtComplete ? DISTRICT_COMPLETE_MULTIPLIER : 1);
}

/** One upgrade level costs 50% of the space's list price (spec §8). */
export function upgradeCost(listPrice: number): number {
  return listPrice * UPGRADE_COST_RATE;
}

/** Selling built levels back returns 50% of the price originally paid (spec §7). */
export function upgradeSellBackProceeds(cumulativeUpgradeSpend: number): number {
  return cumulativeUpgradeSpend * UPGRADE_SELL_BACK_RATE;
}

/** Taking a mortgage pays out 50% of the list price (spec §8). */
export function mortgageProceeds(listPrice: number): number {
  return listPrice * MORTGAGE_PAYOUT_RATE;
}

/** The mortgage liability carried by a mortgaged space: 50% of list price (spec §9). */
export function mortgageLiability(listPrice: number): number {
  return listPrice * MORTGAGE_LIABILITY_RATE;
}

/** Lifting a mortgage costs 110% of the list price (spec §8). */
export function unmortgageCost(listPrice: number): number {
  return listPrice * UNMORTGAGE_COST_RATE;
}

/** Transit hub rent: $60 with one hub, $150 with both (spec §8). */
export function hubRent(hubsOwned: number): number {
  return hubsOwned >= 2 ? 150 : 60;
}

/**
 * City service charge: the dice total × 6 with one service owned, × 18 with
 * both; an unowned service charges nobody (spec §8).
 */
export function serviceCharge(diceTotal: number, servicesOwned: number): number {
  if (!Number.isInteger(diceTotal) || diceTotal < 2 || diceTotal > 12) {
    throw new Error(`rules-v1: diceTotal must be a 2d6 total (2–12), got ${diceTotal}`);
  }
  if (servicesOwned >= 2) return diceTotal * SERVICE_MULTIPLIER_BOTH;
  if (servicesOwned === 1) return diceTotal * SERVICE_MULTIPLIER_SINGLE;
  return 0;
}

/**
 * What an assessment space charges when landed on (spec §8): the Assessment
 * Office is a flat $120; the Municipal Levy takes 8% of the payer's current
 * cash, rounded to the nearest $5.
 */
export function assessmentCharge(space: Pick<AssessmentSpace, 'taxKind' | 'levy'>, cash: number): number {
  if (cash < 0) throw new Error(`rules-v1: cash must be non-negative, got ${cash}`);
  switch (space.levy.kind) {
    case 'FLAT':
      return space.levy.amount;
    case 'CASH_RATE':
      return round5(cash * space.levy.cashRate);
  }
}

/**
 * Rent Holiday: the holder's next RENT payment (only rent — never taxes,
 * service charges, or card penalties) is halved, rounded down to a multiple
 * of $5 (spec §4). Sub-$5 residues floor to $0 — the token is spent either
 * way.
 */
export function rentHolidayAdjusted(rent: number): number {
  if (rent < 0) throw new Error(`rules-v1: rent must be non-negative, got ${rent}`);
  return floor5(rent / 2);
}

/** Board index of a space id; unknown ids are board-data bugs, not player input. */
export function spaceIndex(spaces: readonly BoardSpace[], id: SpaceId): number {
  const index = spaces.findIndex((space) => space.id === id);
  if (index < 0) throw new Error(`board data: unknown space id "${id}"`);
  return index;
}

export interface CardMoveOutcome {
  readonly toIndex: number;
  readonly direction: MoveDirection;
  /** True when the forward walk passed or landed on Gateway Terminal — pay the
   *  start bonus (spec §4). Backward movement never grants it. */
  readonly passesGateway: boolean;
}

/**
 * Resolve a movement card's effect to a concrete board move (spec §4):
 * "move to X" cards count as landing on X, approached forward around the
 * loop; "move back N" retreats without ever granting the start bonus; the
 * transit pass walks forward to the nearest hub. Pure — the reducer applies
 * the returned move through its ordinary movement path (PR 5).
 */
export function resolveCardMove(spaces: readonly BoardSpace[], fromIndex: number, effect: CardMoveEffect): CardMoveOutcome {
  if (!Number.isInteger(fromIndex) || fromIndex < 0 || fromIndex >= spaces.length) {
    throw new Error(`rules-v1: fromIndex out of board range, got ${fromIndex}`);
  }
  switch (effect.kind) {
    case 'MOVE_TO': {
      const toIndex = spaceIndex(spaces, effect.spaceId);
      if (toIndex === fromIndex) {
        throw new Error(`board data: card moves to its own draw space "${effect.spaceId}" — unsupported`);
      }
      return { toIndex, direction: 'FORWARD', passesGateway: toIndex === 0 || toIndex < fromIndex };
    }
    case 'MOVE_TO_NEAREST_HUB': {
      const hubIndexes = spaces.map((space, index) => (space.kind === 'HUB' ? index : -1)).filter((index) => index >= 0);
      if (hubIndexes.length === 0) throw new Error('board data: MOVE_TO_NEAREST_HUB needs a hub on the board');
      // Forward distance to each hub; a zero distance (already there) counts as a full loop.
      let bestIndex = hubIndexes[0];
      let bestDistance = (bestIndex - fromIndex + spaces.length) % spaces.length || spaces.length;
      for (const hubIndex of hubIndexes.slice(1)) {
        const distance = (hubIndex - fromIndex + spaces.length) % spaces.length || spaces.length;
        if (distance < bestDistance) {
          bestIndex = hubIndex;
          bestDistance = distance;
        }
      }
      return { toIndex: bestIndex, direction: 'FORWARD', passesGateway: bestIndex === 0 || bestIndex < fromIndex };
    }
    case 'MOVE_BACK': {
      if (!Number.isInteger(effect.spaces) || effect.spaces <= 0 || effect.spaces >= spaces.length) {
        throw new Error(`rules-v1: MOVE_BACK spaces must be within the board, got ${effect.spaces}`);
      }
      return { toIndex: (fromIndex - effect.spaces + spaces.length) % spaces.length, direction: 'BACKWARD', passesGateway: false };
    }
  }
}

/** One owned space, as net worth sees it (spec §9). */
export interface NetWorthHolding {
  readonly listPrice: number;
  readonly mortgaged: boolean;
  /** Total upgradeCost actually paid for this space's built levels; 0 at level 0. */
  readonly cumulativeUpgradeSpend: number;
}

export interface NetWorthInput {
  readonly cash: number;
  readonly holdings: readonly NetWorthHolding[];
}

/**
 * The canonical net worth (spec §9) — the ONLY net-worth arithmetic in the
 * codebase. Gameplay, leaderboards, victory evaluation, and results all call
 * this. Per spec §9:
 *
 *   netWorth(p) = cash
 *     + Σ unmortgaged: listPrice
 *     + Σ mortgaged: (listPrice − mortgageLiability)   // equity, liability counted once
 *     + Σ all owned: 0.5 × cumulativeUpgradeSpend      // realizable liquidation value
 *
 * No double-counting: the liability lives inside the mortgage equity term;
 * there is no global liability subtraction. Pending payments never appear —
 * a debt is settled or bankrupted before any victory evaluation, so inputs
 * describe settled state only. An auction bargain counts at full list price
 * (Decision D-8) — value is the asset, not the price paid.
 */
export function netWorth({ cash, holdings }: NetWorthInput): number {
  let total = cash;
  for (const holding of holdings) {
    total += holding.mortgaged ? holding.listPrice - mortgageLiability(holding.listPrice) : holding.listPrice;
    total += upgradeSellBackProceeds(holding.cumulativeUpgradeSpend);
  }
  return total;
}
