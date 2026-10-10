import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CommandType, GameCommand } from '../../src/lib/game/commands';
import type { AnyGameEvent } from '../../src/lib/game/events';
import { applyCommand } from '../../src/lib/game/engine/reducer';
import { maxLiquidationValue, isDebtHopeless } from '../../src/lib/game/engine/debt';
import { rngForState } from '../../src/lib/game/rng';
import { BANK_ID, RULES_VERSION, type DebtState, type GameState, type PlayerId, type PlayerState } from '../../src/lib/game/types';

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

function applyErr(state: GameState, type: CommandType, opts: { actor?: PlayerId; payload?: Record<string, unknown> } = {}): string {
  const result = applyCommand(state, makeCommand(state, type, opts), rngForState(state.rngState));
  assert.ok(!result.ok, `${type} must be rejected`);
  if (result.ok) throw new Error('unreachable');
  return result.error.code;
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

/** Hand-build a PLAYING state (economy fixtures: ownership, levels, debts). */
function craftedState(overrides: {
  players?: PlayerState[];
  activePlayerId?: PlayerId | null;
  turnPhase?: GameState['turnPhase'];
  rngState?: number;
  owners?: Record<string, PlayerId>;
  upgrades?: Record<string, number>;
  mortgaged?: Record<string, boolean>;
  eventDeck?: { drawPile: string[]; discardPile: string[] };
  debt?: DebtState;
} = {}): GameState {
  return {
    gameId: 'g-econ',
    version: 7,
    phase: 'PLAYING',
    turnPhase: overrides.turnPhase ?? 'AWAITING_ROLL',
    mode: 'CLASSIC',
    doublesCount: 0,
    owners: overrides.owners ?? {},
    upgrades: overrides.upgrades ?? {},
    mortgaged: overrides.mortgaged ?? {},
    eventDeck: overrides.eventDeck ?? { drawPile: [], discardPile: [] },
    debt: overrides.debt ?? null,
    auction: null,
    trade: null,
    rulesVersion: RULES_VERSION,
    seed: 1,
    rngState: overrides.rngState ?? 1,
    players: overrides.players ?? [mkPlayer({ id: 'Ada', seat: 0 }), mkPlayer({ id: 'Grace', seat: 1 })],
    activePlayerId: overrides.activePlayerId !== undefined ? overrides.activePlayerId : 'Ada',
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

/** Seed whose first roll sums to `sum` (used to pin the landing space). */
function seedForSum(sum: number): number {
  return findSeed(500, (s) => {
    const [a, b] = firstRoll(s);
    return a + b === sum;
  });
}

// ---------------------------------------------------------------------------
// Row 3 — property rent (spec §8: base 10%, level multipliers, district ×2)

describe('rent — property', () => {
  // Position 3 + a roll of 2 rests on foundry-anvil ($100, FOUNDRY_ROW) — a
  // mid-board landing: no start bonus, so rent is the only cash movement.
  const SEED_SUM2 = seedForSum(2);

  it('charges base rent (10% of list price) to a lone owner and credits them', () => {
    const state = craftedState({
      players: [mkPlayer({ id: 'Ada', seat: 0, position: 3 }), mkPlayer({ id: 'Grace', seat: 1 })],
      rngState: SEED_SUM2,
      owners: { 'foundry-anvil': 'Grace' },
    });
    const { state: s1, events } = applyOk(state, 'ROLL');

    assert.deepEqual(eventTypes(events), ['DICE_ROLLED', 'PLAYER_MOVED', 'RENT_PAID']);
    assert.equal(cashOf(s1, 'Ada'), 1500 - 10);
    assert.equal(cashOf(s1, 'Grace'), 1500 + 10);
    assert.equal(s1.turnPhase, 'TURN_MANAGEMENT');
    const rent = events.find((e) => e.type === 'RENT_PAID');
    assert.ok(rent && rent.type === 'RENT_PAID');
    assert.equal(rent.payload.amount, 10);
    assert.equal(rent.payload.payerId, 'Ada');
    assert.equal(rent.payload.ownerId, 'Grace');
    assert.equal(rent.payload.spaceId, 'foundry-anvil');
    assert.equal(rent.payload.rentHolidayApplied, false);
    assert.deepEqual(rent.payload.detail, { via: 'PROPERTY', base: 10, levelMultiplier: 1, districtMultiplier: 1 });
  });

  it('multiplies rent by the owner’s built level (level 2 → ×7)', () => {
    const state = craftedState({
      players: [mkPlayer({ id: 'Ada', seat: 0, position: 3 }), mkPlayer({ id: 'Grace', seat: 1 })],
      rngState: SEED_SUM2,
      owners: { 'foundry-anvil': 'Grace' },
      upgrades: { 'foundry-anvil': 2 },
    });
    const { state: s1, events } = applyOk(state, 'ROLL');

    assert.equal(cashOf(s1, 'Ada'), 1500 - 70);
    assert.equal(cashOf(s1, 'Grace'), 1500 + 70);
    const rent = events.find((e) => e.type === 'RENT_PAID');
    assert.ok(rent && rent.type === 'RENT_PAID');
    assert.equal(rent.payload.amount, 70);
    assert.deepEqual(rent.payload.detail, { via: 'PROPERTY', base: 10, levelMultiplier: 7, districtMultiplier: 1 });
  });

  it('doubles rent when the owner holds the whole district', () => {
    const state = craftedState({
      players: [mkPlayer({ id: 'Ada', seat: 0, position: 3 }), mkPlayer({ id: 'Grace', seat: 1 })],
      rngState: SEED_SUM2,
      owners: { 'foundry-smeltery': 'Grace', 'foundry-brasshouse': 'Grace', 'foundry-anvil': 'Grace' },
    });
    const { state: s1, events } = applyOk(state, 'ROLL');

    assert.equal(cashOf(s1, 'Ada'), 1500 - 20);
    const rent = events.find((e) => e.type === 'RENT_PAID');
    assert.ok(rent && rent.type === 'RENT_PAID');
    assert.equal(rent.payload.amount, 20);
    assert.deepEqual(rent.payload.detail, { via: 'PROPERTY', base: 10, levelMultiplier: 1, districtMultiplier: 2 });
  });

  it('combines district and level multipliers', () => {
    const state = craftedState({
      players: [mkPlayer({ id: 'Ada', seat: 0, position: 3 }), mkPlayer({ id: 'Grace', seat: 1 })],
      rngState: SEED_SUM2,
      owners: { 'foundry-smeltery': 'Grace', 'foundry-brasshouse': 'Grace', 'foundry-anvil': 'Grace' },
      upgrades: { 'foundry-anvil': 1 },
    });
    const { state: s1 } = applyOk(state, 'ROLL');
    // 10 × 3 (level 1) × 2 (district) = 60.
    assert.equal(cashOf(s1, 'Ada'), 1500 - 60);
  });

  it('charges nothing on landing on your own property — and consumes no Rent Holiday', () => {
    const state = craftedState({
      players: [mkPlayer({ id: 'Ada', seat: 0, position: 3, tokens: { HOLD: 0, RENT_HOLIDAY: 1 } }), mkPlayer({ id: 'Grace', seat: 1 })],
      rngState: SEED_SUM2,
      owners: { 'foundry-anvil': 'Ada' },
    });
    const { state: s1, events } = applyOk(state, 'ROLL');
    assert.equal(cashOf(s1, 'Ada'), 1500);
    assert.equal(eventTypes(events).includes('RENT_PAID'), false);
    assert.equal(eventTypes(events).includes('TOKEN_CONSUMED'), false);
    assert.equal(s1.turnPhase, 'TURN_MANAGEMENT');
  });

  it('charges no rent on a mortgaged property — and consumes no Rent Holiday', () => {
    const state = craftedState({
      players: [mkPlayer({ id: 'Ada', seat: 0, position: 3, tokens: { HOLD: 0, RENT_HOLIDAY: 1 } }), mkPlayer({ id: 'Grace', seat: 1 })],
      rngState: SEED_SUM2,
      owners: { 'foundry-anvil': 'Grace' },
      mortgaged: { 'foundry-anvil': true },
    });
    const { state: s1, events } = applyOk(state, 'ROLL');
    assert.equal(cashOf(s1, 'Ada'), 1500);
    assert.equal(cashOf(s1, 'Grace'), 1500);
    assert.equal(eventTypes(events).includes('RENT_PAID'), false);
    assert.equal(eventTypes(events).includes('TOKEN_CONSUMED'), false);
  });

  it('leaves an unowned property in BUY_DECISION (no rent, no charge)', () => {
    const state = craftedState({
      players: [mkPlayer({ id: 'Ada', seat: 0, position: 3 }), mkPlayer({ id: 'Grace', seat: 1 })],
      rngState: SEED_SUM2,
    });
    const { state: s1, events } = applyOk(state, 'ROLL');
    assert.equal(eventTypes(events).includes('RENT_PAID'), false);
    assert.equal(s1.turnPhase, 'BUY_DECISION');
  });
});

// ---------------------------------------------------------------------------
// Row 3 — hub rent (spec §8: $60 single hub, $150 both hubs)

describe('rent — transit hubs', () => {
  // Position 4 + a roll of 2 rests on hub-central-relay (index 6).
  const SEED_SUM2 = seedForSum(2);

  it('charges $60 when the owner holds one hub', () => {
    const state = craftedState({
      players: [mkPlayer({ id: 'Ada', seat: 0, position: 4 }), mkPlayer({ id: 'Grace', seat: 1 })],
      rngState: SEED_SUM2,
      owners: { 'hub-central-relay': 'Grace' },
    });
    const { state: s1, events } = applyOk(state, 'ROLL');

    assert.equal(cashOf(s1, 'Ada'), 1500 - 60);
    assert.equal(cashOf(s1, 'Grace'), 1500 + 60);
    const rent = events.find((e) => e.type === 'RENT_PAID');
    assert.ok(rent && rent.type === 'RENT_PAID');
    assert.equal(rent.payload.amount, 60);
    assert.deepEqual(rent.payload.detail, { via: 'HUB', hubCount: 1 });
  });

  it('charges $150 when the owner holds both hubs', () => {
    const state = craftedState({
      players: [mkPlayer({ id: 'Ada', seat: 0, position: 4 }), mkPlayer({ id: 'Grace', seat: 1 })],
      rngState: SEED_SUM2,
      owners: { 'hub-central-relay': 'Grace', 'hub-aurora-junction': 'Grace' },
    });
    const { state: s1, events } = applyOk(state, 'ROLL');

    assert.equal(cashOf(s1, 'Ada'), 1500 - 150);
    const rent = events.find((e) => e.type === 'RENT_PAID');
    assert.ok(rent && rent.type === 'RENT_PAID');
    assert.equal(rent.payload.amount, 150);
    assert.deepEqual(rent.payload.detail, { via: 'HUB', hubCount: 2 });
  });

  it('applies the Rent Holiday to hub rent (rent is rent)', () => {
    const state = craftedState({
      players: [mkPlayer({ id: 'Ada', seat: 0, position: 4, tokens: { HOLD: 0, RENT_HOLIDAY: 1 } }), mkPlayer({ id: 'Grace', seat: 1 })],
      rngState: SEED_SUM2,
      owners: { 'hub-central-relay': 'Grace' },
    });
    const { state: s1, events } = applyOk(state, 'ROLL');
    assert.equal(cashOf(s1, 'Ada'), 1500 - 30);
    assert.equal(cashOf(s1, 'Grace'), 1500 + 30);
    const rent = events.find((e) => e.type === 'RENT_PAID');
    assert.ok(rent && rent.type === 'RENT_PAID');
    assert.equal(rent.payload.rentHolidayApplied, true);
  });
});

// ---------------------------------------------------------------------------
// Rent Holiday token (spec §4, §8)

describe('Rent Holiday token', () => {
  const SEED_SUM2 = seedForSum(2);

  it('halves the due rent, floors to the nearest $5, and is consumed', () => {
    // foundry-anvil level 2: rent 70 → 35 → $35 (already a $5 multiple).
    const state = craftedState({
      players: [mkPlayer({ id: 'Ada', seat: 0, position: 3, tokens: { HOLD: 0, RENT_HOLIDAY: 1 } }), mkPlayer({ id: 'Grace', seat: 1 })],
      rngState: SEED_SUM2,
      owners: { 'foundry-anvil': 'Grace' },
      upgrades: { 'foundry-anvil': 2 },
    });
    const { state: s1, events } = applyOk(state, 'ROLL');

    assert.deepEqual(eventTypes(events), ['DICE_ROLLED', 'PLAYER_MOVED', 'TOKEN_CONSUMED', 'RENT_PAID']);
    assert.equal(cashOf(s1, 'Ada'), 1500 - 35);
    const ada = s1.players.find((p) => p.id === 'Ada');
    assert.ok(ada);
    assert.equal(ada.tokens.RENT_HOLIDAY, 0);
    const rent = events.find((e) => e.type === 'RENT_PAID');
    assert.ok(rent && rent.type === 'RENT_PAID');
    assert.equal(rent.payload.amount, 35);
    assert.equal(rent.payload.rentHolidayApplied, true);
  });

  it('rounds a sub-$5 due to zero — the holiday can erase a tiny rent', () => {
    // foundry-smeltery base rent is $6; halved = $3 → owed as nothing.
    const state = craftedState({
      players: [mkPlayer({ id: 'Ada', seat: 0, position: 29, tokens: { HOLD: 0, RENT_HOLIDAY: 1 } }), mkPlayer({ id: 'Grace', seat: 1 })],
      rngState: seedForSum(4),
      owners: { 'foundry-smeltery': 'Grace' },
    });
    const { state: s1, events } = applyOk(state, 'ROLL');

    // Position 29 + 4 crosses Gateway Terminal: bonus in, rent $0 out.
    assert.deepEqual(eventTypes(events), ['DICE_ROLLED', 'PLAYER_MOVED', 'START_BONUS_PAID', 'TOKEN_CONSUMED', 'RENT_PAID']);
    assert.equal(cashOf(s1, 'Ada'), 1750);
    const rent = events.find((e) => e.type === 'RENT_PAID');
    assert.ok(rent && rent.type === 'RENT_PAID');
    assert.equal(rent.payload.amount, 0);
    assert.equal(rent.payload.rentHolidayApplied, true);
  });
});

// ---------------------------------------------------------------------------
// Debt entry (spec §7) — a due payment beyond the payer's cash

describe('debt entry on landing', () => {
  const SEED_SUM2 = seedForSum(2);

  it('records the creditor, due amount, and reason, and pauses in SETTLING_DEBT', () => {
    const state = craftedState({
      players: [mkPlayer({ id: 'Ada', seat: 0, position: 3, cash: 5 }), mkPlayer({ id: 'Grace', seat: 1 })],
      rngState: SEED_SUM2,
      owners: { 'foundry-anvil': 'Grace' },
      upgrades: { 'foundry-anvil': 2 }, // rent 70, cash 5 → short
    });
    const { state: s1, events } = applyOk(state, 'ROLL');

    assert.deepEqual(eventTypes(events), ['DICE_ROLLED', 'PLAYER_MOVED', 'DEBT_ENTERED']);
    assert.equal(s1.turnPhase, 'SETTLING_DEBT');
    assert.deepEqual(s1.debt, { debtorId: 'Ada', creditorId: 'Grace', amountDue: 70, reason: 'RENT' });
    // Nothing was applied: the payer keeps their cash and the owner is not credited.
    assert.equal(cashOf(s1, 'Ada'), 5);
    assert.equal(cashOf(s1, 'Grace'), 1500);
  });

  it('consumes the Rent Holiday before the affordability test — the debt is the halved amount', () => {
    const state = craftedState({
      players: [mkPlayer({ id: 'Ada', seat: 0, position: 3, cash: 4, tokens: { HOLD: 0, RENT_HOLIDAY: 1 } }), mkPlayer({ id: 'Grace', seat: 1 })],
      rngState: SEED_SUM2,
      owners: { 'foundry-anvil': 'Grace' },
    });
    const { state: s1, events } = applyOk(state, 'ROLL');

    assert.deepEqual(eventTypes(events), ['DICE_ROLLED', 'PLAYER_MOVED', 'TOKEN_CONSUMED', 'DEBT_ENTERED']);
    assert.deepEqual(s1.debt, { debtorId: 'Ada', creditorId: 'Grace', amountDue: 5, reason: 'RENT' });
    const ada = s1.players.find((p) => p.id === 'Ada');
    assert.ok(ada);
    assert.equal(ada.tokens.RENT_HOLIDAY, 0);
  });
});

// ---------------------------------------------------------------------------
// Rows 13/14 — SETTLE_DEBT (transitional: settleable debts resolve atomically)

describe('SETTLE_DEBT', () => {
  function settlingState(overrides: { cash?: number; debt?: DebtState } = {}): GameState {
    const debt: DebtState = overrides.debt ?? { debtorId: 'Ada', creditorId: 'Grace', amountDue: 60, reason: 'RENT' };
    return craftedState({
      players: [mkPlayer({ id: 'Ada', seat: 0, cash: overrides.cash ?? 100 }), mkPlayer({ id: 'Grace', seat: 1 })],
      turnPhase: 'SETTLING_DEBT',
      debt,
    });
  }

  it('pays the creditor once, atomically, and proceeds to TURN_MANAGEMENT', () => {
    const state = settlingState();
    const { state: s1, events } = applyOk(state, 'SETTLE_DEBT');

    assert.deepEqual(eventTypes(events), ['DEBT_SETTLED']);
    assert.equal(cashOf(s1, 'Ada'), 100 - 60);
    assert.equal(cashOf(s1, 'Grace'), 1500 + 60);
    assert.equal(s1.debt, null);
    assert.equal(s1.turnPhase, 'TURN_MANAGEMENT');
    const settled = events[0];
    assert.ok(settled.type === 'DEBT_SETTLED');
    assert.deepEqual(settled.payload, { debtorId: 'Ada', creditorId: 'Grace', amount: 60 });
  });

  it('conserves total player cash on a player-creditor settlement', () => {
    const state = settlingState();
    const before = state.players.reduce((sum, p) => sum + p.cash, 0);
    const { state: s1 } = applyOk(state, 'SETTLE_DEBT');
    const after = s1.players.reduce((sum, p) => sum + p.cash, 0);
    assert.equal(after, before);
  });

  it('absorbs the payment when the creditor is the bank', () => {
    const state = settlingState({ debt: { debtorId: 'Ada', creditorId: BANK_ID, amountDue: 45, reason: 'CARD' } });
    const { state: s1, events } = applyOk(state, 'SETTLE_DEBT');

    assert.equal(cashOf(s1, 'Ada'), 100 - 45);
    assert.equal(cashOf(s1, 'Grace'), 1500);
    assert.equal(s1.debt, null);
    const settled = events[0];
    assert.ok(settled.type === 'DEBT_SETTLED');
    assert.equal(settled.payload.creditorId, 'BANK');
  });

  it('rejects with INSUFFICIENT_RESOURCES when cash is short but recovery is possible — state untouched', () => {
    // $50 cash < $60 due, but the unmortgaged Anvil ($50 mortgage payout)
    // keeps the debt settleable — the handler's own rejection fires, not the
    // hopeless-debt veto (which outranks it when recovery is impossible).
    const state = craftedState({
      players: [mkPlayer({ id: 'Ada', seat: 0, cash: 50 }), mkPlayer({ id: 'Grace', seat: 1 })],
      turnPhase: 'SETTLING_DEBT',
      debt: { debtorId: 'Ada', creditorId: 'Grace', amountDue: 60, reason: 'RENT' },
      owners: { 'foundry-anvil': 'Ada' },
    });
    const before = structuredClone(state);
    const result = applyCommand(state, makeCommand(state, 'SETTLE_DEBT'), rngForState(state.rngState));
    assert.ok(!result.ok);
    assert.equal(result.error.code, 'INSUFFICIENT_RESOURCES');
    assert.deepEqual(state, before);
  });

  it('a hopeless short-cash state rejects DEBT_UNRESOLVABLE before the handler runs', () => {
    const state = settlingState({ cash: 50 }); // $50 max recoverable < $60 due
    assert.equal(applyErr(state, 'SETTLE_DEBT'), 'DEBT_UNRESOLVABLE');
  });

  it('rejects with INVALID_PHASE outside SETTLING_DEBT', () => {
    const state = craftedState({ turnPhase: 'TURN_MANAGEMENT' });
    assert.equal(applyErr(state, 'SETTLE_DEBT'), 'INVALID_PHASE');
  });

  it('rejects settlement by anyone but the debtor', () => {
    const state = craftedState({
      players: [mkPlayer({ id: 'Ada', seat: 0, cash: 100 }), mkPlayer({ id: 'Grace', seat: 1 })],
      turnPhase: 'SETTLING_DEBT',
      // Defensive mismatch fixture: the recorded debtor is Grace while Ada is
      // active — the handler must refuse Ada's settlement attempt.
      debt: { debtorId: 'Grace', creditorId: 'Ada', amountDue: 60, reason: 'RENT' },
    });
    assert.equal(applyErr(state, 'SETTLE_DEBT', { actor: 'Ada' }), 'NOT_AUTHORIZED');
  });
});

// ---------------------------------------------------------------------------
// Liquidation arithmetic (spec §7): max recoverable and hopeless detection

describe('maxLiquidationValue and isDebtHopeless', () => {
  it('counts the mortgage payout for level-0 unmortgaged property', () => {
    const state = craftedState({ owners: { 'foundry-anvil': 'Ada' } });
    // 50% of the $100 list price.
    assert.equal(maxLiquidationValue(state, 'Ada'), 50);
  });

  it('adds 50% of price paid per built level', () => {
    const state = craftedState({
      owners: { 'foundry-anvil': 'Ada' },
      upgrades: { 'foundry-anvil': 2 },
    });
    // Mortgage payout 50 + two levels × $25 (50% of the $50-per-level cost).
    assert.equal(maxLiquidationValue(state, 'Ada'), 50 + 2 * 25);
  });

  it('counts only sell-backs on an already-mortgaged space', () => {
    const state = craftedState({
      owners: { 'foundry-anvil': 'Ada' },
      upgrades: { 'foundry-anvil': 2 },
      mortgaged: { 'foundry-anvil': true },
    });
    assert.equal(maxLiquidationValue(state, 'Ada'), 2 * 25);
  });

  it('sums across every owned space', () => {
    const state = craftedState({
      owners: { 'foundry-anvil': 'Ada', 'hub-central-relay': 'Ada', 'market-coppermonger': 'Grace' },
    });
    // anvil $100 → 50; hub $200 → 100; Grace's space is excluded.
    assert.equal(maxLiquidationValue(state, 'Ada'), 150);
  });

  it('isDebtHopeless is false exactly at the boundary (cash + liquidation == due)', () => {
    const state = craftedState({
      players: [mkPlayer({ id: 'Ada', seat: 0, cash: 40 })],
      owners: { 'foundry-anvil': 'Ada' },
      debt: { debtorId: 'Ada', creditorId: 'Grace', amountDue: 90, reason: 'RENT' },
    });
    assert.equal(isDebtHopeless(state, state.debt as DebtState), false);
    const hopeless = craftedState({
      players: [mkPlayer({ id: 'Ada', seat: 0, cash: 40 })],
      owners: { 'foundry-anvil': 'Ada' },
      debt: { debtorId: 'Ada', creditorId: 'Grace', amountDue: 91, reason: 'RENT' },
    });
    assert.equal(isDebtHopeless(hopeless, hopeless.debt as DebtState), true);
  });
});
