import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { craftedState } from './ui-crafted';
import { FIRST_PROPERTY_ID } from './ui-spaces';
import { modalPlan } from '../../src/lib/game/ui/modals';

/** Modal prioritization (spec §11): forced surfaces, one-open discipline, dismissal keyed by trade id. */

const AUCTION = {
  auctionId: 'a-1',
  spaceId: FIRST_PROPERTY_ID,
  reason: 'DECLINED',
  currentBid: 20,
  highBidderId: 'Grace',
  passedPlayerIds: [],
  eligiblePlayerIds: ['Ada', 'Grace'],
} as const;

const PENDING = {
  tradeId: 'tr-1',
  proposerId: 'Grace',
  recipientId: 'Ada',
  offer: { give: { cash: 0, spaceIds: [] }, receive: { cash: 0, spaceIds: [] } },
  anchorTurn: null,
} as const;

const ui = (overrides: { tradeBuilderOpen?: boolean; counterOf?: string | null; dismissedTradeId?: string | null } = {}) => ({
  tradeBuilderOpen: overrides.tradeBuilderOpen ?? false,
  counterOf: overrides.counterOf ?? null,
  dismissedTradeId: overrides.dismissedTradeId ?? null,
});

describe('modalPlan — forced surfaces', () => {
  it('an open auction wins over every other surface', () => {
    const plan = modalPlan(craftedState({ auction: AUCTION }), ui({ tradeBuilderOpen: true }));
    assert.deepEqual(plan, { kind: 'AUCTION' });
  });

  it('a due debt outranks trade surfaces', () => {
    const state = craftedState({
      turnPhase: 'SETTLING_DEBT',
      debt: { debtorId: 'Ada', creditorId: 'BANK', amountDue: 200, reason: 'TAX' },
      trade: PENDING,
    });
    const plan = modalPlan(state, ui({ tradeBuilderOpen: true }));
    assert.equal(plan.kind, 'DEBT');
  });
});

describe('modalPlan — trade surfaces', () => {
  it('shows the review for a pending offer, suppressed when that offer was dismissed', () => {
    const shown = modalPlan(craftedState({ trade: PENDING, activePlayerId: 'Ada' }), ui());
    assert.equal(shown.kind, 'TRADE_REVIEW');

    const dismissed = modalPlan(craftedState({ trade: PENDING, activePlayerId: 'Ada' }), ui({ dismissedTradeId: 'tr-1' }));
    assert.equal(dismissed.kind, 'NONE');

    // A NEW offer (different id) re-opens the review — a dismissal is keyed to one offer.
    const replaced = modalPlan(craftedState({ trade: { ...PENDING, tradeId: 'tr-2' }, activePlayerId: 'Ada' }), ui({ dismissedTradeId: 'tr-1' }));
    assert.equal(replaced.kind, 'TRADE_REVIEW');
  });

  it('a counter composer outranks the review and opens in any phase while that offer pends', () => {
    for (const turnPhase of ['AWAITING_ROLL', 'TURN_MANAGEMENT'] as const) {
      const state = craftedState({ trade: PENDING, activePlayerId: 'Ada', turnPhase });
      const plan = modalPlan(state, ui({ tradeBuilderOpen: true, counterOf: 'tr-1' }));
      assert.deepEqual(plan, { kind: 'TRADE_BUILDER', counterOf: 'tr-1' }, turnPhase);
    }
  });

  it('a fresh composer is a TURN_MANAGEMENT action only — a dismissal defers to the dock trigger', () => {
    const state = craftedState({ turnPhase: 'TURN_MANAGEMENT', activePlayerId: 'Ada' });
    const plan = modalPlan(state, ui({ tradeBuilderOpen: true }));
    assert.deepEqual(plan, { kind: 'TRADE_BUILDER', counterOf: null });

    // The open flag alone is not a render — outside TURN_MANAGEMENT nothing shows.
    const outside = modalPlan(craftedState({ turnPhase: 'AWAITING_ROLL' }), ui({ tradeBuilderOpen: true }));
    assert.equal(outside.kind, 'NONE');
  });

  it('a dismissed review stays dismissed while the composer flag is off', () => {
    const state = craftedState({ trade: PENDING, activePlayerId: 'Ada' });
    assert.equal(modalPlan(state, ui({ dismissedTradeId: 'tr-1' })).kind, 'NONE');
  });
});

describe('modalPlan — quiet by default', () => {
  it('no auction, no debt, no trade, no composer → NONE', () => {
    const plan = modalPlan(craftedState({ turnPhase: 'TURN_MANAGEMENT' }), ui());
    assert.equal(plan.kind, 'NONE');
  });

  it('never plans anything outside PLAYING', () => {
    for (const phase of ['LOBBY', 'GAME_OVER'] as const) {
      const plan = modalPlan(craftedState({ phase, auction: AUCTION }), ui({ tradeBuilderOpen: true }));
      assert.equal(plan.kind, 'NONE', phase);
    }
  });
});
