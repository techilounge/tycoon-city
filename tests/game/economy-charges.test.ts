import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CommandType, GameCommand } from '../../src/lib/game/commands';
import type { AnyGameEvent } from '../../src/lib/game/events';
import { applyCommand } from '../../src/lib/game/engine/reducer';
import { rngForState } from '../../src/lib/game/rng';
import { EVENT_DECK_CATALOG } from '../../src/lib/game/board-v1';
import { BANK_ID, RULES_VERSION, type GameState, type PlayerId, type PlayerState } from '../../src/lib/game/types';

// ---------------------------------------------------------------------------
// Helpers (per-file copies of the established turn-machine pattern)

function firstRoll(seed: number): [number, number] {
  const rng = rngForState(seed);
  return [rng.nextInt(6) + 1, rng.nextInt(6) + 1];
}

function findSeed(maxSeed: number, predicate: (seed: number) => boolean): number {
  for (let seed = 1; seed <= maxSeed; seed++) {
    if (predicate(seed)) return seed;
  }
  throw new Error(`test data: no seed ≤ ${maxSeed} satisfies the dice predicate`);
}

let commandSeq = 0;
function makeCommand(
  state: GameState,
  type: CommandType,
  opts: { actor?: PlayerId; payload?: Record<string, unknown>; commandId?: string } = {},
): GameCommand {
  return {
    commandId: opts.commandId ?? `cmd-${++commandSeq}`,
    gameId: state.gameId,
    actorId: opts.actor ?? state.activePlayerId ?? state.players[0].id,
    expectedVersion: state.version,
    type,
    payload: opts.payload ?? {},
  } as GameCommand;
}

function applyOk(state: GameState, type: CommandType, opts: { actor?: PlayerId; payload?: Record<string, unknown> } = {}): {
  state: GameState;
  events: readonly AnyGameEvent[];
} {
  const result = applyCommand(state, makeCommand(state, type, opts), rngForState(state.rngState));
  assert.ok(result.ok, `${type} must apply: ${result.ok ? '' : result.error.message}`);
  if (!result.ok) throw new Error('unreachable');
  return result;
}

function mkPlayer(overrides: { id: PlayerId; seat: number } & Partial<PlayerState>): PlayerState {
  return {
    eliminated: false,
    position: 0,
    cash: 1500,
    tokens: { HOLD: 0, RENT_HOLIDAY: 0 },
    skipNextTurn: false,
    ...overrides,
  };
}

/** Hand-build a PLAYING state with an explicit event deck. */
function craftedState(overrides: {
  players?: PlayerState[];
  turnPhase?: GameState['turnPhase'];
  rngState?: number;
  owners?: Record<string, PlayerId>;
  drawPile?: string[];
  discardPile?: string[];
} = {}): GameState {
  return {
    gameId: 'g-charges',
    version: 7,
    phase: 'PLAYING',
    turnPhase: overrides.turnPhase ?? 'AWAITING_ROLL',
    mode: 'CLASSIC',
    doublesCount: 0,
    owners: overrides.owners ?? {},
    upgrades: {},
    mortgaged: {},
    eventDeck: { drawPile: overrides.drawPile ?? [], discardPile: overrides.discardPile ?? [] },
    debt: null,
    auction: null,
    rulesVersion: RULES_VERSION,
    seed: 1,
    rngState: overrides.rngState ?? 1,
    players: overrides.players ?? [mkPlayer({ id: 'Ada', seat: 0 }), mkPlayer({ id: 'Grace', seat: 1 })],
    activePlayerId: 'Ada',
    turn: 3,
    lastEventSequence: 40,
    processedCommandIds: [],
  };
}

function eventTypes(events: readonly AnyGameEvent[]): string[] {
  return events.map((e) => e.type);
}

function cashOf(state: GameState, id: PlayerId): number {
  const player = state.players.find((p) => p.id === id);
  assert.ok(player);
  return player.cash;
}

function tokenOf(state: GameState, id: PlayerId, token: 'HOLD' | 'RENT_HOLIDAY'): number {
  const player = state.players.find((p) => p.id === id);
  assert.ok(player);
  return player.tokens[token];
}

/** Seed whose first roll sums to `sum` (pins the landing space). */
function seedForSum(sum: number): number {
  return findSeed(500, (s) => {
    const [a, b] = firstRoll(s);
    return a + b === sum;
  });
}

const ALL_CARD_IDS = EVENT_DECK_CATALOG.map((c) => c.id);
const OTHER_IDS = (head: string): string[] => ALL_CARD_IDS.filter((id) => id !== head);

/** Seed whose first roll sums to 2 — lands the mover two spaces ahead. */
const SEED_SUM2 = seedForSum(2);

// ---------------------------------------------------------------------------
// Row 3 — assessments (spec §8: Assessment Office $120 flat; Municipal Levy
// 8% of cash rounded down to whole dollars; both charged to the bank)

describe('assessments', () => {
  // Position 2 + a roll of 2 rests on municipal-levy (index 4).
  it('charges the Municipal Levy as 8% of cash, floored to whole dollars', () => {
    const state = craftedState({
      players: [mkPlayer({ id: 'Ada', seat: 0, position: 2, cash: 1555 }), mkPlayer({ id: 'Grace', seat: 1 })],
      rngState: SEED_SUM2,
    });
    const { state: s1, events } = applyOk(state, 'ROLL');

    assert.deepEqual(eventTypes(events), ['DICE_ROLLED', 'PLAYER_MOVED', 'TAX_PAID']);
    assert.equal(cashOf(s1, 'Ada'), 1555 - 125); // 8% of 1555 = 124.4 → round5 → 125
    const tax = events.find((e) => e.type === 'TAX_PAID');
    assert.ok(tax && tax.type === 'TAX_PAID');
    assert.equal(tax.payload.amount, 125);
    assert.equal(tax.payload.taxKind, 'MUNICIPAL_LEVY');
    assert.equal(tax.payload.levyCashBasis, 1555);
  });

  it('charges the Assessment Office flat $120', () => {
    // Position 13 + 2 rests on assessment-office (index 15).
    const state = craftedState({
      players: [mkPlayer({ id: 'Ada', seat: 0, position: 13 }), mkPlayer({ id: 'Grace', seat: 1 })],
      rngState: SEED_SUM2,
    });
    const { state: s1, events } = applyOk(state, 'ROLL');

    assert.equal(cashOf(s1, 'Ada'), 1380);
    const tax = events.find((e) => e.type === 'TAX_PAID');
    assert.ok(tax && tax.type === 'TAX_PAID');
    assert.equal(tax.payload.amount, 120);
    assert.equal(tax.payload.taxKind, 'ASSESSMENT_OFFICE');
    assert.equal(tax.payload.levyCashBasis, undefined);
  });

  it('rounds a tiny levy to zero', () => {
    const state = craftedState({
      players: [mkPlayer({ id: 'Ada', seat: 0, position: 2, cash: 12 }), mkPlayer({ id: 'Grace', seat: 1 })],
      rngState: SEED_SUM2,
    });
    const { state: s1, events } = applyOk(state, 'ROLL');

    assert.equal(cashOf(s1, 'Ada'), 12); // round5(0.96) = 0
    const tax = events.find((e) => e.type === 'TAX_PAID');
    assert.ok(tax && tax.type === 'TAX_PAID');
    assert.equal(tax.payload.amount, 0);
  });

  it('never drives the payer into debt — 8% of cash cannot exceed cash', () => {
    const state = craftedState({
      players: [mkPlayer({ id: 'Ada', seat: 0, position: 2, cash: 5 }), mkPlayer({ id: 'Grace', seat: 1 })],
      rngState: SEED_SUM2,
    });
    const { state: s1, events } = applyOk(state, 'ROLL');
    assert.equal(eventTypes(events).includes('DEBT_ENTERED'), false);
    assert.equal(s1.turnPhase, 'TURN_MANAGEMENT');
    assert.equal(s1.debt, null);
  });

  it('does not consume the Rent Holiday (non-rent charge)', () => {
    const state = craftedState({
      players: [mkPlayer({ id: 'Ada', seat: 0, position: 13, tokens: { HOLD: 0, RENT_HOLIDAY: 1 } }), mkPlayer({ id: 'Grace', seat: 1 })],
      rngState: SEED_SUM2,
    });
    const { state: s1, events } = applyOk(state, 'ROLL');
    assert.equal(cashOf(s1, 'Ada'), 1380); // full $120
    assert.equal(eventTypes(events).includes('TOKEN_CONSUMED'), false);
    assert.equal(tokenOf(s1, 'Ada', 'RENT_HOLIDAY'), 1);
  });

  it('enters debt when the flat assessment exceeds cash', () => {
    const state = craftedState({
      players: [mkPlayer({ id: 'Ada', seat: 0, position: 13, cash: 100 }), mkPlayer({ id: 'Grace', seat: 1 })],
      rngState: SEED_SUM2,
    });
    const { state: s1, events } = applyOk(state, 'ROLL');

    assert.deepEqual(eventTypes(events), ['DICE_ROLLED', 'PLAYER_MOVED', 'DEBT_ENTERED']);
    assert.deepEqual(s1.debt, { debtorId: 'Ada', creditorId: BANK_ID, amountDue: 120, reason: 'TAX' });
    assert.equal(cashOf(s1, 'Ada'), 100); // nothing applied
    assert.equal(s1.turnPhase, 'SETTLING_DEBT');
  });
});

// ---------------------------------------------------------------------------
// Row 3 — city services (spec §8: ownable spaces — the owner charges the
// landed player 6× the dice total, or 18× while holding BOTH services)

describe('city services', () => {
  const SEED_SUM9 = seedForSum(9);

  it('charges 6× the dice total to an owner holding one service (Powerworks, index 12)', () => {
    // Position 10 + 2 → 12.
    const state = craftedState({
      players: [mkPlayer({ id: 'Ada', seat: 0, position: 10 }), mkPlayer({ id: 'Grace', seat: 1 })],
      rngState: SEED_SUM2,
      owners: { 'service-powerworks': 'Grace' },
    });
    const { state: s1, events } = applyOk(state, 'ROLL');

    assert.deepEqual(eventTypes(events), ['DICE_ROLLED', 'PLAYER_MOVED', 'SERVICE_CHARGED']);
    assert.equal(cashOf(s1, 'Ada'), 1500 - 12);
    assert.equal(cashOf(s1, 'Grace'), 1500 + 12);
    const charge = events.find((e) => e.type === 'SERVICE_CHARGED');
    assert.ok(charge && charge.type === 'SERVICE_CHARGED');
    assert.equal(charge.payload.amount, 12);
    assert.equal(charge.payload.diceTotal, 2);
    assert.equal(charge.payload.multiplier, 6);
    assert.equal(charge.payload.spaceId, 'service-powerworks');
  });

  it('charges 18× the dice total when the owner holds both services (Waterline, index 21)', () => {
    // Position 19 + 2 → 21.
    const state = craftedState({
      players: [mkPlayer({ id: 'Ada', seat: 0, position: 19 }), mkPlayer({ id: 'Grace', seat: 1 })],
      rngState: SEED_SUM2,
      owners: { 'service-powerworks': 'Grace', 'service-waterline': 'Grace' },
    });
    const { state: s1, events } = applyOk(state, 'ROLL');
    assert.equal(cashOf(s1, 'Ada'), 1500 - 36);
    assert.equal(cashOf(s1, 'Grace'), 1500 + 36);
    const charge = events.find((e) => e.type === 'SERVICE_CHARGED');
    assert.ok(charge && charge.type === 'SERVICE_CHARGED');
    assert.equal(charge.payload.multiplier, 18);
    assert.equal(charge.payload.diceTotal, 2);
    assert.equal(charge.payload.spaceId, 'service-waterline');
  });

  it('scales with the dice total (9 → 18×9 = $162)', () => {
    // Position 3 + 9 → 12.
    const state = craftedState({
      players: [mkPlayer({ id: 'Ada', seat: 0, position: 3 }), mkPlayer({ id: 'Grace', seat: 1 })],
      rngState: SEED_SUM9,
      owners: { 'service-powerworks': 'Grace', 'service-waterline': 'Grace' },
    });
    const { state: s1 } = applyOk(state, 'ROLL');
    assert.equal(cashOf(s1, 'Ada'), 1500 - 162);
  });

  it('charges nothing on an unowned service space', () => {
    const state = craftedState({
      players: [mkPlayer({ id: 'Ada', seat: 0, position: 10 }), mkPlayer({ id: 'Grace', seat: 1 })],
      rngState: SEED_SUM2,
    });
    const { state: s1, events } = applyOk(state, 'ROLL');
    assert.equal(cashOf(s1, 'Ada'), 1500);
    assert.equal(eventTypes(events).includes('SERVICE_CHARGED'), false);
  });

  it('charges nothing when the owner lands on their own service', () => {
    const state = craftedState({
      players: [mkPlayer({ id: 'Ada', seat: 0, position: 10 }), mkPlayer({ id: 'Grace', seat: 1 })],
      rngState: SEED_SUM2,
      owners: { 'service-powerworks': 'Ada' },
    });
    const { state: s1, events } = applyOk(state, 'ROLL');
    assert.equal(cashOf(s1, 'Ada'), 1500);
    assert.equal(eventTypes(events).includes('SERVICE_CHARGED'), false);
  });

  it('does not consume the Rent Holiday (non-rent charge)', () => {
    const state = craftedState({
      players: [mkPlayer({ id: 'Ada', seat: 0, position: 10, tokens: { HOLD: 0, RENT_HOLIDAY: 1 } }), mkPlayer({ id: 'Grace', seat: 1 })],
      rngState: SEED_SUM2,
      owners: { 'service-powerworks': 'Grace' },
    });
    const { state: s1, events } = applyOk(state, 'ROLL');
    assert.equal(cashOf(s1, 'Ada'), 1488); // full $12
    assert.equal(eventTypes(events).includes('TOKEN_CONSUMED'), false);
    assert.equal(tokenOf(s1, 'Ada', 'RENT_HOLIDAY'), 1);
  });

  it('enters debt when the service charge exceeds cash', () => {
    const state = craftedState({
      players: [mkPlayer({ id: 'Ada', seat: 0, position: 10, cash: 2 }), mkPlayer({ id: 'Grace', seat: 1 })],
      rngState: SEED_SUM2,
      owners: { 'service-powerworks': 'Grace' },
    });
    const { state: s1, events } = applyOk(state, 'ROLL');

    assert.deepEqual(eventTypes(events), ['DICE_ROLLED', 'PLAYER_MOVED', 'DEBT_ENTERED']);
    assert.deepEqual(s1.debt, { debtorId: 'Ada', creditorId: 'Grace', amountDue: 12, reason: 'SERVICE' });
    assert.equal(s1.turnPhase, 'SETTLING_DEBT');
  });
});

// ---------------------------------------------------------------------------
// Row 3 — the Event Deck (18 cards: movement, cash, and token effects;
// draw from the head, reshuffle the discard through the seeded RNG)

describe('event deck', () => {
  // position 0 + 2 → event-city-wire (index 2)

  /** Deck with `head` on top of the draw pile. */
  function deckState(head: string, overrides: { players?: PlayerState[]; position?: number; rngState?: number } = {}): GameState {
    const players = overrides.players ?? [mkPlayer({ id: 'Ada', seat: 0, position: overrides.position ?? 0 }), mkPlayer({ id: 'Grace', seat: 1 })];
    return craftedState({
      players,
      rngState: overrides.rngState ?? SEED_SUM2,
      drawPile: [head, ...OTHER_IDS(head)],
      discardPile: [],
    });
  }

  function cardById(id: string) {
    const card = EVENT_DECK_CATALOG.find((c) => c.id === id);
    assert.ok(card, `catalog must contain ${id}`);
    return card;
  }

  it('PAY card charges the bank the stated amount', () => {
    const { state: s1, events } = applyOk(deckState('municipal-fine'), 'ROLL'); // pay $100

    assert.deepEqual(eventTypes(events), ['DICE_ROLLED', 'PLAYER_MOVED', 'CARD_DRAWN', 'CARD_EFFECT_APPLIED']);
    assert.equal(cashOf(s1, 'Ada'), 1400);
    const drawn = events.find((e) => e.type === 'CARD_DRAWN');
    assert.ok(drawn && drawn.type === 'CARD_DRAWN');
    assert.equal(drawn.meta.cardId, 'municipal-fine');
    const applied = events.find((e) => e.type === 'CARD_EFFECT_APPLIED');
    assert.ok(applied && applied.type === 'CARD_EFFECT_APPLIED');
    assert.equal(applied.payload.cardId, 'municipal-fine');
    assert.deepEqual(applied.payload.effect, cardById('municipal-fine').effect);
  });

  it('COLLECT card pays the player from the bank', () => {
    const { state: s1, events } = applyOk(deckState('dividend-disbursement'), 'ROLL'); // collect $100
    assert.deepEqual(eventTypes(events), ['DICE_ROLLED', 'PLAYER_MOVED', 'CARD_DRAWN', 'CARD_EFFECT_APPLIED']);
    assert.equal(cashOf(s1, 'Ada'), 1600);
    const applied = events.find((e) => e.type === 'CARD_EFFECT_APPLIED');
    assert.ok(applied && applied.type === 'CARD_EFFECT_APPLIED');
    assert.deepEqual(applied.payload.effect, cardById('dividend-disbursement').effect);
  });

  it('GRANT_TOKEN card adds the token and consumes nothing', () => {
    const { state: s1, events } = applyOk(deckState('small-business-relief'), 'ROLL'); // Rent Holiday
    assert.equal(tokenOf(s1, 'Ada', 'RENT_HOLIDAY'), 1);
    assert.equal(eventTypes(events).includes('TOKEN_CONSUMED'), false);
    assert.equal(cashOf(s1, 'Ada'), 1500);
  });

  it('MOVE_TO a forward destination grants the start bonus on landing Gateway', () => {
    // Land on event-night-market (index 10), draw Summons from City Hall →
    // Gateway Terminal: a forward card move that collects the bonus.
    const state = deckState('summons-city-hall', { position: 8 });
    const { state: s1, events } = applyOk(state, 'ROLL');

    assert.deepEqual(eventTypes(events), [
      'DICE_ROLLED', 'PLAYER_MOVED', 'CARD_DRAWN', 'CARD_EFFECT_APPLIED', 'PLAYER_MOVED', 'START_BONUS_PAID',
    ]);
    const ada = s1.players.find((p) => p.id === 'Ada');
    assert.ok(ada);
    assert.equal(ada.position, 0);
    assert.equal(cashOf(s1, 'Ada'), 1750);
  });

  it('MOVE_BACK never grants the start bonus', () => {
    // Land on event-city-wire (2), draw Parade Blocks the Line: the dice move
    // already happened (0 → 2), so back 3 wraps 2 → 31 (crown-summit).
    const state = deckState('parade-blocks-line', { position: 0 });
    const { state: s1, events } = applyOk(state, 'ROLL');

    assert.equal(eventTypes(events).includes('START_BONUS_PAID'), false);
    const ada = s1.players.find((p) => p.id === 'Ada');
    assert.ok(ada);
    assert.equal(ada.position, 31);
    assert.equal(cashOf(s1, 'Ada'), 1500);
    // Lands on an unowned property → the normal buy decision.
    assert.equal(s1.turnPhase, 'BUY_DECISION');
  });

  it('card movement onto an owned property charges rent', () => {
    // Land on event-night-market (10), draw Trade Summit → Exchange Boulevard
    // (index 24, $300) owned by Grace: rent $30.
    const state = deckState('trade-summit', {
      players: [mkPlayer({ id: 'Ada', seat: 0, position: 8 }), mkPlayer({ id: 'Grace', seat: 1 })],
    });
    const owners = { 'midtown-exchange': 'Grace' as PlayerId };
    const withOwners = { ...state, owners };
    const { state: s1, events } = applyOk(withOwners, 'ROLL');

    assert.deepEqual(eventTypes(events), [
      'DICE_ROLLED', 'PLAYER_MOVED', 'CARD_DRAWN', 'CARD_EFFECT_APPLIED', 'PLAYER_MOVED', 'RENT_PAID',
    ]);
    assert.equal(cashOf(s1, 'Ada'), 1470);
    assert.equal(cashOf(s1, 'Grace'), 1530);
  });

  it('MOVE_TO_NEAREST_HUB rides to the nearest hub', () => {
    const state = deckState('transit-day-pass', { position: 0 });
    const { state: s1 } = applyOk(state, 'ROLL');
    const ada = s1.players.find((p) => p.id === 'Ada');
    assert.ok(ada);
    assert.equal(ada.position, 6); // hub-central-relay, 6 ahead vs 17
    assert.equal(s1.turnPhase, 'BUY_DECISION');
  });

  it('draws the discard reshuffle lazily — the last card leaves the pile empty', () => {
    // Drawing the final card must not reshuffle mid-draw: the pile empties,
    // the discard holds the whole catalog, and the NEXT draw reshuffles.
    const head = 'municipal-fine';
    const state = craftedState({
      players: [mkPlayer({ id: 'Ada', seat: 0, position: 0 }), mkPlayer({ id: 'Grace', seat: 1 })],
      rngState: SEED_SUM2,
      drawPile: [head],
      discardPile: OTHER_IDS(head),
    });
    const { state: s1 } = applyOk(state, 'ROLL');

    assert.equal(s1.eventDeck.drawPile.length, 0);
    assert.deepEqual([...s1.eventDeck.discardPile].sort(), [...ALL_CARD_IDS].sort());
  });

  it('shuffles the full catalog through the seeded RNG when a game starts with no deck', () => {
    // Crafted states carry an empty deck: the first event-space draw builds
    // the pile from the catalog itself — same branch as a discard reshuffle.
    const state = craftedState({
      players: [mkPlayer({ id: 'Ada', seat: 0, position: 0 }), mkPlayer({ id: 'Grace', seat: 1 })],
      rngState: SEED_SUM2,
    });
    const { state: s1 } = applyOk(state, 'ROLL');

    assert.equal(s1.eventDeck.discardPile.length, 1);
    assert.equal(s1.eventDeck.drawPile.length, ALL_CARD_IDS.length - 1);
    const drawn = s1.eventDeck.discardPile[0];
    assert.ok(drawn !== undefined && ALL_CARD_IDS.includes(drawn));
    assert.deepEqual(
      [...s1.eventDeck.drawPile, drawn].sort(),
      [...ALL_CARD_IDS].sort(),
      'the full catalog is preserved across the reshuffle',
    );
  });

  it('is deterministic — identical crafted state and command produce identical events', () => {
    const run = (): string => {
      const state = deckState('municipal-fine');
      const result = applyCommand(state, makeCommand(state, 'ROLL', { commandId: 'fixed-id' }), rngForState(state.rngState));
      assert.ok(result.ok);
      return JSON.stringify(result.events);
    };
    assert.equal(run(), run());
  });
});
