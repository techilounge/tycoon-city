import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { craftedState } from './ui-crafted';
import { FIRST_PROPERTY_ID } from './ui-spaces';
import { modalPlan, pendingCardReveal, pendingElimination } from '../../src/lib/game/ui/modals';
import type { AnyGameEvent } from '../../src/lib/game/events';

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

const ui = (
  overrides: {
    tradeBuilderOpen?: boolean;
    counterOf?: string | null;
    dismissedTradeId?: string | null;
    cardRevealPending?: boolean;
    bankruptcyPending?: boolean;
    victoryUnacknowledged?: boolean;
  } = {},
) => ({
  tradeBuilderOpen: overrides.tradeBuilderOpen ?? false,
  counterOf: overrides.counterOf ?? null,
  dismissedTradeId: overrides.dismissedTradeId ?? null,
  cardRevealPending: overrides.cardRevealPending ?? false,
  bankruptcyPending: overrides.bankruptcyPending ?? false,
  victoryUnacknowledged: overrides.victoryUnacknowledged ?? false,
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

  it('nothing plans outside PLAYING except an unacknowledged victory at GAME_OVER', () => {
    for (const phase of ['LOBBY', 'GAME_OVER'] as const) {
      const plan = modalPlan(craftedState({ phase, auction: AUCTION }), ui({ tradeBuilderOpen: true }));
      assert.equal(plan.kind, 'NONE', phase);
    }
    const victory = modalPlan(craftedState({ phase: 'GAME_OVER' }), ui({ victoryUnacknowledged: true, tradeBuilderOpen: true }));
    assert.deepEqual(victory, { kind: 'VICTORY' });
  });
});

describe('modalPlan — reveal surfaces', () => {
  it('an unacknowledged bankruptcy outranks a card reveal and trade surfaces', () => {
    const plan = modalPlan(craftedState({ trade: PENDING }), ui({ bankruptcyPending: true, cardRevealPending: true }));
    assert.equal(plan.kind, 'BANKRUPTCY');
  });

  it('an unseen card reveal outranks trade surfaces but not a due debt', () => {
    const plan = modalPlan(craftedState({ trade: PENDING }), ui({ cardRevealPending: true }));
    assert.equal(plan.kind, 'EVENT_REVEAL');

    const inDebt = modalPlan(
      craftedState({
        turnPhase: 'SETTLING_DEBT',
        debt: { debtorId: 'Ada', creditorId: 'BANK', amountDue: 200, reason: 'TAX' },
      }),
      ui({ cardRevealPending: true }),
    );
    assert.equal(inDebt.kind, 'DEBT');
  });
});

describe('pendingCardReveal', () => {
  // Card facts are REAL catalog rows — the reveal resolves the card id, it never
  // invents titles. municipal-fine: 'Municipal Fine Notice', PAY 100 (board-v1).
  const draw: AnyGameEvent = {
    eventId: 'e-draw',
    gameId: 'g-test',
    sequence: 3,
    rulesVersion: 1,
    commandId: 'ui-test',
    type: 'CARD_DRAWN',
    payload: { playerId: 'Ada' },
    meta: { cardId: 'municipal-fine' },
  };
  const applied: AnyGameEvent = {
    eventId: 'e-applied',
    gameId: 'g-test',
    sequence: 4,
    rulesVersion: 1,
    commandId: 'ui-test',
    type: 'CARD_EFFECT_APPLIED',
    payload: { playerId: 'Ada', cardId: 'municipal-fine', effect: { kind: 'PAY', amount: 100 } },
    meta: {},
  };

  it('resolves the last unseen draw against the catalog with its applied effect', () => {
    const reveal = pendingCardReveal([draw, applied], 0);
    assert.ok(reveal);
    assert.equal(reveal.sequence, 3);
    assert.equal(reveal.playerId, 'Ada');
    assert.equal(reveal.title, 'Municipal Fine Notice');
    assert.equal(reveal.text, 'An unpaid permit surfaces. Pay the bank $100.');
    assert.deepEqual(reveal.effect, { kind: 'PAY', amount: 100 });
  });

  it('nothing unseen, or everything already acknowledged, yields null', () => {
    assert.equal(pendingCardReveal([], 0), null);
    assert.equal(pendingCardReveal([draw, applied], 4), null);
  });
});

describe('pendingElimination', () => {
  const bankrupt: AnyGameEvent = {
    eventId: 'e-bankrupt',
    gameId: 'g-test',
    sequence: 7,
    rulesVersion: 1,
    commandId: 'ui-test',
    type: 'PLAYER_BANKRUPT',
    payload: { playerId: 'Grace', creditorId: 'BANK' },
    meta: {},
  };
  const transferred: AnyGameEvent = {
    eventId: 'e-transfer',
    gameId: 'g-test',
    sequence: 8,
    rulesVersion: 1,
    commandId: 'ui-test',
    type: 'ASSETS_TRANSFERRED',
    payload: { fromId: 'Grace', toId: 'BANK', cash: 340, spaceIds: ['harbor-saltmarket'] },
    meta: {},
  };
  const eliminated: AnyGameEvent = {
    eventId: 'e-elim',
    gameId: 'g-test',
    sequence: 9,
    rulesVersion: 1,
    commandId: 'ui-test',
    type: 'PLAYER_ELIMINATED',
    payload: { playerId: 'Grace' },
    meta: {},
  };

  it('collects the estate facts from the waterfall events that preceded the elimination', () => {
    const reveal = pendingElimination([bankrupt, transferred, eliminated], 0);
    assert.ok(reveal);
    assert.equal(reveal.sequence, 9);
    assert.equal(reveal.playerId, 'Grace');
    assert.equal(reveal.creditorId, 'BANK');
    assert.equal(reveal.transferredCash, 340);
    assert.deepEqual(reveal.transferredSpaceIds, ['harbor-saltmarket']);
  });

  it('an acknowledged elimination never re-shows; an empty history yields null', () => {
    assert.equal(pendingElimination([bankrupt, transferred, eliminated], 9), null);
    assert.equal(pendingElimination([], 0), null);
  });
});
