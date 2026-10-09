/**
 * Transitional debt settlement (spec §7; §17.2 amendment 2).
 *
 * PR 5 scope is settleable debts only: unilateral liquidation
 * (SELL_UPGRADE, MORTGAGE), one atomic SETTLE_DEBT payment, and — when cash
 * plus maximum liquidation still cannot cover the due amount — a typed
 * DEBT_UNRESOLVABLE rejection that changes nothing, leaving the game paused
 * in SETTLING_DEBT. SURRENDER, the bankruptcy waterfall, asset transfers,
 * and elimination auctions are PR 8 scope: this build is structurally
 * unable to emit PLAYER_BANKRUPT, ASSETS_TRANSFERRED, or PLAYER_ELIMINATED
 * (the SettlementEventInput union below simply has no such member, and no
 * handler here could construct one), and PR 8 replaces this rejection seam
 * with the real waterfall.
 *
 * Hopeless detection is pure state arithmetic — no timers: the engine
 * computes max recoverable = cash + Σ liquidation values and compares it to
 * the due amount (spec §7).
 */
import { BOARD_SPACES, isPurchasable, type PurchasableSpace } from '../board-v1';
import type { GameCommand } from '../commands';
import type { EventInput } from '../events';
import { mortgageProceeds, upgradeCost, upgradeSellBackProceeds } from '../rules-v1';
import type { DebtState, GameState, PlayerId } from '../types';
import { BANK_ID } from '../types';
import { RuleError } from './errors';
import type { GameStateDraft } from './draft';
import { requirePlayer } from './draft';

/** The event vocabulary of the transitional settlement surface. PR 8's
 *  waterfall widens this union with PLAYER_BANKRUPT, ASSETS_TRANSFERRED,
 *  and PLAYER_ELIMINATED when it replaces the rejection seam — until then
 *  the type system itself blocks those events from every handler here. */
export type SettlementEventInput =
  | EventInput<'DEBT_SETTLED'>
  | EventInput<'UPGRADE_SOLD'>
  | EventInput<'MORTGAGE_TAKEN'>;

/**
 * The most cash the player can raise without consent (spec §7): upgrade
 * sell-backs at 50% of price paid per level, plus the mortgage payout of
 * 50% of list price for every space not already mortgaged. Selling the
 * levels of an unmortgaged space first and then mortgaging it at level 0 is
 * legal inside SETTLING_DEBT, so both terms count together; a space already
 * under mortgage contributes only its sell-backs.
 */
export function maxLiquidationValue(state: GameState, playerId: PlayerId): number {
  let total = 0;
  for (const [spaceId, ownerId] of Object.entries(state.owners)) {
    if (ownerId !== playerId) continue;
    const space = BOARD_SPACES.find((candidate) => candidate.id === spaceId);
    if (!space || !isPurchasable(space)) {
      throw new Error(`engine bug: owned space "${spaceId}" is not a purchasable board space`);
    }
    const level = state.upgrades[spaceId] ?? 0;
    if (level > 0) total += level * upgradeSellBackProceeds(upgradeCost(space.listPrice));
    if (!state.mortgaged[spaceId]) total += mortgageProceeds(space.listPrice);
  }
  return total;
}

/**
 * True when the debtor cannot reach the due amount even by liquidating
 * everything (spec §7). Pure — evaluated on demand for every command while
 * a debt is open, never cached, never timer-driven.
 */
export function isDebtHopeless(state: GameState, debt: DebtState): boolean {
  const debtor = state.players.find((player) => player.id === debt.debtorId);
  if (!debtor) throw new Error(`engine bug: debtor ${debt.debtorId} not found`);
  return debtor.cash + maxLiquidationValue(state, debt.debtorId) < debt.amountDue;
}

/** The owned purchasable space a liquidation command names, after the
 *  ownership rule has been checked. A miss is an engine bug (the caller
 *  verified ownership), not a rule outcome. */
function requireOwnedSpace(draft: GameStateDraft, playerId: PlayerId, spaceId: string): PurchasableSpace {
  const space = BOARD_SPACES.find((candidate) => candidate.id === spaceId);
  if (!space || !isPurchasable(space)) {
    throw new RuleError('RULE_VIOLATION', `space ${spaceId} is not a purchasable space`, { spaceId });
  }
  if (draft.owners[spaceId] !== playerId) {
    throw new RuleError('RULE_VIOLATION', `space ${spaceId} is not owned by player ${playerId}`, {
      spaceId,
      ownerId: draft.owners[spaceId] ?? null,
    });
  }
  return space;
}

/** The open debt on the draft after the phase check has proven one exists. */
function requireOpenDebt(draft: GameStateDraft): DebtState {
  if (draft.turnPhase !== 'SETTLING_DEBT' || draft.debt === null) {
    throw new RuleError('INVALID_PHASE', `this command is only valid in SETTLING_DEBT, not ${String(draft.turnPhase)}`, {
      phase: draft.turnPhase,
    });
  }
  return draft.debt;
}

/**
 * Row 14: the debtor pays the due amount once, atomically (spec §7) — one
 * command, one event, cash to the creditor, no partial application. The
 * turn then proceeds to TURN_MANAGEMENT.
 */
export function settleDebtHandler(draft: GameStateDraft, command: GameCommand): SettlementEventInput[] {
  const debt = requireOpenDebt(draft);
  if (debt.debtorId !== command.actorId) {
    throw new RuleError('NOT_AUTHORIZED', `only the debtor ${debt.debtorId} may settle the debt`, {
      debtorId: debt.debtorId,
      actorId: command.actorId,
    });
  }
  const debtor = requirePlayer(draft, debt.debtorId);
  if (debtor.cash < debt.amountDue) {
    throw new RuleError(
      'INSUFFICIENT_RESOURCES',
      `settling the ${debt.reason.toLowerCase()} debt of $${debt.amountDue} needs $${debt.amountDue} in cash; the debtor holds $${debtor.cash} — liquidate first`,
      { amountDue: debt.amountDue, cash: debtor.cash, reason: debt.reason },
    );
  }
  debtor.cash -= debt.amountDue;
  if (debt.creditorId !== BANK_ID) requirePlayer(draft, debt.creditorId).cash += debt.amountDue;
  draft.debt = null;
  draft.turnPhase = 'TURN_MANAGEMENT';
  return [{ type: 'DEBT_SETTLED', payload: { debtorId: debt.debtorId, creditorId: debt.creditorId, amount: debt.amountDue } }];
}
