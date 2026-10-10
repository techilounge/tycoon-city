import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CommandType, GameCommand } from '../../src/lib/game/commands';
import type { AnyGameEvent } from '../../src/lib/game/events';
import type { EconomyEventInput } from '../../src/lib/game/engine/economy';
import type { SettlementEventInput } from '../../src/lib/game/engine/debt';
import { applyCommand } from '../../src/lib/game/engine/reducer';
import { isDebtHopeless, maxLiquidationValue } from '../../src/lib/game/engine/debt';
import { rngForState } from '../../src/lib/game/rng';
import { BANK_ID, RULES_VERSION, type DebtState, type GameState, type PlayerId, type PlayerState } from '../../src/lib/game/types';

// ---------------------------------------------------------------------------
// Helpers (per-file copies of the established turn-machine pattern)

let commandSeq = 0;
function makeCommand(
  state: GameState,
  type: CommandType,
  opts: { actor?: PlayerId; payload?: Record<string, unknown>; commandId?: string; expectedVersion?: number } = {},
): GameCommand {
  return {
    commandId: opts.commandId ?? `cmd-${++commandSeq}`,
    gameId: state.gameId,
    actorId: opts.actor ?? state.activePlayerId ?? state.players[0].id,
    expectedVersion: opts.expectedVersion ?? state.version,
    type,
    payload: opts.payload ?? {},
  } as GameCommand;
}

function applyOk(state: GameState, type: CommandType, opts: { actor?: PlayerId; payload?: Record<string, unknown>; commandId?: string } = {}): {
  state: GameState;
  events: readonly AnyGameEvent[];
} {
  const result = applyCommand(state, makeCommand(state, type, opts), rngForState(state.rngState));
  assert.ok(result.ok, `${type} must apply: ${result.ok ? '' : result.error.message}`);
  if (!result.ok) throw new Error('unreachable');
  return result;
}

function applyErrCode(state: GameState, type: CommandType, opts: { actor?: PlayerId; payload?: Record<string, unknown>; commandId?: string } = {}): string {
  const result = applyCommand(state, makeCommand(state, type, opts), rngForState(state.rngState));
  assert.ok(!result.ok, `${type} must be rejected`);
  if (result.ok) throw new Error('unreachable');
  return result.error.code;
}

function mkPlayer(overrides: { id: PlayerId; seat: number } & Partial<PlayerState>): PlayerState {
  return {
    eliminated: false,
    position: 1,
    cash: 1500,
    tokens: { HOLD: 0, RENT_HOLIDAY: 0 },
    skipNextTurn: false,
    ...overrides,
  };
}

/** Hand-build a PLAYING state for settlement fixtures. */
function craftedState(overrides: {
  players?: PlayerState[];
  activePlayerId?: PlayerId | null;
  turnPhase?: GameState['turnPhase'];
  phase?: GameState['phase'];
  rngState?: number;
  owners?: Record<string, PlayerId>;
  upgrades?: Record<string, number>;
  mortgaged?: Record<string, boolean>;
  debt?: DebtState;
  processedCommandIds?: string[];
} = {}): GameState {
  return {
    gameId: 'g-debt',
    version: 7,
    phase: overrides.phase ?? 'PLAYING',
    turnPhase: overrides.turnPhase ?? 'SETTLING_DEBT',
    mode: 'CLASSIC',
    doublesCount: 0,
    owners: overrides.owners ?? {},
    upgrades: overrides.upgrades ?? {},
    mortgaged: overrides.mortgaged ?? {},
    eventDeck: { drawPile: [], discardPile: [] },
    debt: overrides.debt ?? null,
    auction: null,
    trade: null,
    estateSale: null,
    rulesVersion: RULES_VERSION,
    seed: 1,
    rngState: overrides.rngState ?? 1,
    players: overrides.players ?? [mkPlayer({ id: 'Ada', seat: 0 }), mkPlayer({ id: 'Grace', seat: 1 })],
    activePlayerId: overrides.activePlayerId ?? overrides.players?.[0]?.id ?? 'Ada',
    turn: 3,
    round: 1,
    lastEventSequence: 10,
    processedCommandIds: overrides.processedCommandIds ?? [],
  } as GameState;
}

const RENT_DUE: DebtState = { debtorId: 'Ada', creditorId: BANK_ID, amountDue: 150, reason: 'RENT' };

/** A settling state: Ada owes $150 rent to the bank (default) with optional
 *  holdings. Anvil & Lathe is $100 — $50 mortgage, $25 sell-back per level. */
function debtState(overrides: {
  players?: PlayerState[];
  owners?: Record<string, PlayerId>;
  upgrades?: Record<string, number>;
  mortgaged?: Record<string, boolean>;
  debt?: DebtState;
  processedCommandIds?: string[];
} = {}): GameState {
  return craftedState({
    ...overrides,
    debt: overrides.debt ?? RENT_DUE,
  });
}

function cashOf(state: GameState, id: PlayerId): number {
  const player = state.players.find((p) => p.id === id);
  assert.ok(player, `player ${id} must exist`);
  return player.cash;
}

function eventTypes(events: readonly AnyGameEvent[]): string[] {
  return events.map((e) => e.type);
}

/** Return the state with one player's cash set — fixtures that need exact
 *  cash arithmetic (the default starting cash is $1,500). */
function withCash(state: GameState, id: PlayerId, cash: number): GameState {
  return { ...state, players: state.players.map((p) => (p.id === id ? { ...p, cash } : p)) };
}

// §17.2: these three event types must be unreachable from this build's
// settlement surface. The type-level half lives in the last describe block.

// ---------------------------------------------------------------------------
// The hopeless-debt rejection seam (spec §17.2 amendment 2)

describe('hopeless-debt rejection seam', () => {
  /** Ada: $20 cash + Anvil level 0 ($50 mortgage) = $70 max < $150 due. */
  function hopelessStateRaw(): GameState {
    const state = debtState({ owners: { 'foundry-anvil': 'Ada' } });
    const ada = state.players.find((p) => p.id === 'Ada');
    assert.ok(ada);
    return { ...state, players: state.players.map((p) => (p.id === 'Ada' ? { ...p, cash: 20 } : p)) };
  }

  it('refuses every liquidation command with DEBT_HOPELESS when cash plus maximum liquidation falls short', () => {
    const state = hopelessStateRaw();
    assert.equal(isDebtHopeless(state, RENT_DUE), true);
    const before = structuredClone(state);

    const spaceCommands = new Set<CommandType>(['BUY', 'SELL_UPGRADE', 'MORTGAGE', 'BUILD', 'UNMORTGAGE']);
    for (const type of [
      'ROLL', 'HOLD', 'BUY', 'PASS_TO_AUCTION', 'SETTLE_DEBT', 'SELL_UPGRADE', 'MORTGAGE', 'END_TURN',
      'START_GAME', 'SAVE_SNAPSHOT',
      'BID', 'PASS_BID', 'BUILD', 'UNMORTGAGE', 'OFFER_TRADE', 'ANSWER_TRADE',
    ] as const) {
      const payload = spaceCommands.has(type) ? { spaceId: 'foundry-anvil' } : {};
      const code = applyErrCode(state, type, { payload });
      assert.equal(code, 'DEBT_HOPELESS', `${type} must be refused by the hopeless-debt veto`);
    }
    assert.deepEqual(state, before, 'the veto must change nothing');
  });

  it('a debtor with no assets at all is hopeless', () => {
    const state = debtState();
    const ada = state.players.find((p) => p.id === 'Ada');
    assert.ok(ada);
    assert.equal(maxLiquidationValue(state, 'Ada'), 0);
    assert.equal(isDebtHopeless({ ...state, players: state.players.map((p) => (p.id === 'Ada' ? { ...p, cash: 20 } : p)) }, RENT_DUE), true);
  });

  it('the PR 5 rejection seam is replaced: SURRENDER resolves a hopeless debt through the waterfall', () => {
    const state = hopelessStateRaw();
    const result = applyCommand(state, makeCommand(state, 'SURRENDER'), rngForState(state.rngState));
    assert.ok(result.ok, `SURRENDER must apply from a hopeless debt: ${result.ok ? '' : result.error.message}`);
    if (!result.ok) return;
    // Bank-creditor estate: cash went to the bank, Anvil enters the estate
    // sale, Ada is bankrupt and out of turn order.
    assert.deepEqual(
      eventTypes(result.events).filter((t) => t === 'PLAYER_BANKRUPT' || t === 'PLAYER_ELIMINATED' || t === 'ASSETS_TRANSFERRED'),
      ['PLAYER_BANKRUPT', 'ASSETS_TRANSFERRED', 'PLAYER_ELIMINATED'],
    );
    assert.equal(cashOf(result.state, 'Ada'), 0);
    const ada = result.state.players.find((p) => p.id === 'Ada');
    assert.ok(ada);
    assert.equal(ada.eliminated, true);
    // Two-player fixture: Ada's elimination makes Grace the last solvent
    // player, so victory evaluation ends the game immediately (spec §4 row
    // 17) — the estate sale never opens. Multi-player estate-sale coverage
    // lives in the endgame suites.
    assert.deepEqual(eventTypes(result.events).filter((t) => t === 'VICTORY_DECIDED' || t === 'GAME_ENDED'), ['VICTORY_DECIDED', 'GAME_ENDED']);
    assert.equal(result.state.phase, 'GAME_OVER');
    assert.equal(result.state.turnPhase, null);
  });

  it('keeps pipeline order — version conflict and unknown actor outrank the veto', () => {
    const state = hopelessStateRaw();

    const stale = makeCommand(state, 'SETTLE_DEBT', { expectedVersion: state.version + 5 });
    const staleResult = applyCommand(state, stale, rngForState(state.rngState));
    assert.ok(!staleResult.ok);
    if (!staleResult.ok) assert.equal(staleResult.error.code, 'VERSION_CONFLICT');

    const stranger = applyErrCode(state, 'SETTLE_DEBT', { actor: 'mallory' as PlayerId });
    assert.equal(stranger, 'UNKNOWN_PLAYER');
  });

  it('lets an idempotent retry of a processed command through the veto unchanged', () => {
    const state = debtState({ processedCommandIds: ['cmd-done'] });
    const before = structuredClone(state);

    const result = applyCommand(state, makeCommand(state, 'SETTLE_DEBT', { commandId: 'cmd-done' }), rngForState(state.rngState));
    assert.ok(result.ok, 'a processed commandId is an idempotent retry, not a veto target');
    if (result.ok) {
      assert.equal(result.applied, false);
      assert.deepEqual(result.events, []);
    }
    assert.deepEqual(state, before);
  });

  it('GAME_IS_OVER outranks the veto', () => {
    const state = hopelessStateRaw();
    const over = { ...state, phase: 'GAME_OVER' as const };
    const code = applyErrCode(over, 'SETTLE_DEBT');
    assert.equal(code, 'GAME_IS_OVER');
  });
});

// ---------------------------------------------------------------------------
// Row 13 — SELL_UPGRADE inside SETTLING_DEBT

describe('SELL_UPGRADE in SETTLING_DEBT', () => {
  it('sells one level for 50% of the price paid, keeping the phase', () => {
    // $60 cash + $100 max liquidation = $160 ≥ $150 due — settleable.
    const state = withCash(
      debtState({ owners: { 'foundry-anvil': 'Ada' }, upgrades: { 'foundry-anvil': 2 } }),
      'Ada',
      60,
    );
    const { state: s1, events } = applyOk(state, 'SELL_UPGRADE', { payload: { spaceId: 'foundry-anvil' } });

    assert.deepEqual(eventTypes(events), ['UPGRADE_SOLD']);
    const sold = events.find((e) => e.type === 'UPGRADE_SOLD');
    assert.ok(sold && sold.type === 'UPGRADE_SOLD');
    assert.deepEqual(sold.payload, { playerId: 'Ada', spaceId: 'foundry-anvil', level: 1, proceeds: 25 });
    assert.equal(cashOf(s1, 'Ada'), 60 + 25);
    assert.equal(s1.upgrades['foundry-anvil'], 1);
    assert.equal(s1.turnPhase, 'SETTLING_DEBT');
    assert.deepEqual(s1.debt, RENT_DUE);
  });

  it('rejects a space with no built levels', () => {
    const state = debtState({ owners: { 'foundry-anvil': 'Ada' } });
    assert.equal(applyErrCode(state, 'SELL_UPGRADE', { payload: { spaceId: 'foundry-anvil' } }), 'RULE_VIOLATION');
  });

  it('rejects a space the debtor does not own', () => {
    const state = debtState({ owners: { 'foundry-anvil': 'Grace' }, upgrades: { 'foundry-anvil': 2 } });
    assert.equal(applyErrCode(state, 'SELL_UPGRADE', { payload: { spaceId: 'foundry-anvil' } }), 'RULE_VIOLATION');
  });

  it('rejects a non-debtor actor', () => {
    const state = debtState({ owners: { 'foundry-anvil': 'Ada' }, upgrades: { 'foundry-anvil': 2 } });
    assert.equal(applyErrCode(state, 'SELL_UPGRADE', { actor: 'Grace', payload: { spaceId: 'foundry-anvil' } }), 'NOT_AUTHORIZED');
  });

  it('also applies in TURN_MANAGEMENT — the PR 8 management leg (50% of price paid)', () => {
    const state = debtState({ owners: { 'foundry-anvil': 'Ada' }, upgrades: { 'foundry-anvil': 2 } });
    const managing = { ...state, turnPhase: 'TURN_MANAGEMENT' as const, debt: null };
    const { state: s1, events } = applyOk(managing, 'SELL_UPGRADE', { payload: { spaceId: 'foundry-anvil' } });
    assert.deepEqual(eventTypes(events), ['UPGRADE_SOLD']);
    assert.equal(cashOf(s1, 'Ada'), 1500 + 25);
    assert.equal(s1.upgrades['foundry-anvil'], 1);
    assert.equal(s1.turnPhase, 'TURN_MANAGEMENT');
  });

  it('liquidation to settlement: two sell-backs clear the debt atomically', () => {
    const state = debtState({
      owners: { 'foundry-anvil': 'Ada' },
      upgrades: { 'foundry-anvil': 2 },
    });
    // $100 cash + 2 × $25 sell-backs = $150 exactly.
    const ada = state.players.find((p) => p.id === 'Ada');
    assert.ok(ada);
    const withCash = { ...state, players: state.players.map((p) => (p.id === 'Ada' ? { ...p, cash: 100 } : p)) };

    const s1 = applyOk(withCash, 'SELL_UPGRADE', { payload: { spaceId: 'foundry-anvil' } }).state;
    const s2 = applyOk(s1, 'SELL_UPGRADE', { payload: { spaceId: 'foundry-anvil' } }).state;
    assert.equal(cashOf(s2, 'Ada'), 150);

    const { state: s3, events } = applyOk(s2, 'SETTLE_DEBT');
    assert.deepEqual(eventTypes(events), ['DEBT_SETTLED']);
    assert.equal(cashOf(s3, 'Ada'), 0);
    assert.equal(s3.debt, null);
    assert.equal(s3.turnPhase, 'TURN_MANAGEMENT');
    assert.equal(s3.upgrades['foundry-anvil'], 0);
  });

  it('applies an idempotent duplicate exactly once', () => {
    const state = debtState({ owners: { 'foundry-anvil': 'Ada' }, upgrades: { 'foundry-anvil': 2 } });
    const first = applyOk(state, 'SELL_UPGRADE', { commandId: 'sell-1', payload: { spaceId: 'foundry-anvil' } });
    const cashAfterFirst = cashOf(first.state, 'Ada');

    // Re-apply the SAME command envelope against the POST-first state — the
    // ledger there contains sell-1, so the retry must apply nothing.
    const retry = applyCommand(first.state, makeCommand(first.state, 'SELL_UPGRADE', { commandId: 'sell-1', payload: { spaceId: 'foundry-anvil' } }), rngForState(first.state.rngState));
    assert.ok(retry.ok);
    if (retry.ok) {
      assert.equal(retry.applied, false);
      assert.deepEqual(retry.events, []);
      assert.equal(cashOf(retry.state, 'Ada'), cashAfterFirst, 'no double proceeds');
      assert.equal(retry.state.upgrades['foundry-anvil'], 1);
    }
  });
});

// ---------------------------------------------------------------------------
// Row 13 — MORTGAGE inside SETTLING_DEBT

describe('MORTGAGE in SETTLING_DEBT', () => {
  it('pays 50% of list price and flags the space, keeping the phase', () => {
    // $120 cash + $50 mortgage = $170 ≥ $150 due — settleable.
    const state = withCash(debtState({ owners: { 'foundry-anvil': 'Ada' } }), 'Ada', 120);
    const { state: s1, events } = applyOk(state, 'MORTGAGE', { payload: { spaceId: 'foundry-anvil' } });

    assert.deepEqual(eventTypes(events), ['MORTGAGE_TAKEN']);
    const taken = events.find((e) => e.type === 'MORTGAGE_TAKEN');
    assert.ok(taken && taken.type === 'MORTGAGE_TAKEN');
    assert.deepEqual(taken.payload, { playerId: 'Ada', spaceId: 'foundry-anvil', proceeds: 50 });
    assert.equal(cashOf(s1, 'Ada'), 120 + 50);
    assert.equal(s1.mortgaged['foundry-anvil'], true);
    assert.equal(s1.turnPhase, 'SETTLING_DEBT');
    assert.deepEqual(s1.debt, RENT_DUE);
  });

  it('rejects a space above level 0 — sell the levels first', () => {
    const state = debtState({ owners: { 'foundry-anvil': 'Ada' }, upgrades: { 'foundry-anvil': 1 } });
    assert.equal(applyErrCode(state, 'MORTGAGE', { payload: { spaceId: 'foundry-anvil' } }), 'RULE_VIOLATION');
  });

  it('rejects a space that is already mortgaged', () => {
    const state = debtState({ owners: { 'foundry-anvil': 'Ada' }, mortgaged: { 'foundry-anvil': true } });
    assert.equal(applyErrCode(state, 'MORTGAGE', { payload: { spaceId: 'foundry-anvil' } }), 'RULE_VIOLATION');
  });

  it('rejects a space the debtor does not own', () => {
    const state = debtState({ owners: { 'foundry-anvil': 'Grace' } });
    assert.equal(applyErrCode(state, 'MORTGAGE', { payload: { spaceId: 'foundry-anvil' } }), 'RULE_VIOLATION');
  });

  it('rejects a non-debtor actor', () => {
    const state = debtState({ owners: { 'foundry-anvil': 'Ada' } });
    assert.equal(applyErrCode(state, 'MORTGAGE', { actor: 'Grace', payload: { spaceId: 'foundry-anvil' } }), 'NOT_AUTHORIZED');
  });

  it('also applies in TURN_MANAGEMENT — the PR 8 management leg (50% of list price)', () => {
    const state = debtState({ owners: { 'foundry-anvil': 'Ada' } });
    const managing = { ...state, turnPhase: 'TURN_MANAGEMENT' as const, debt: null };
    const { state: s1, events } = applyOk(managing, 'MORTGAGE', { payload: { spaceId: 'foundry-anvil' } });
    assert.deepEqual(eventTypes(events), ['MORTGAGE_TAKEN']);
    assert.equal(cashOf(s1, 'Ada'), 1500 + 50);
    assert.equal(s1.mortgaged['foundry-anvil'], true);
    assert.equal(s1.turnPhase, 'TURN_MANAGEMENT');
  });

  it('liquidation to settlement with a player creditor conserves money', () => {
    // Ada: $80 cash + Anvil ($50) + Central Relay hub ($100) — settle $150 to Grace.
    const state = debtState({
      debt: { debtorId: 'Ada', creditorId: 'Grace', amountDue: 150, reason: 'RENT' },
      owners: { 'foundry-anvil': 'Ada', 'hub-central-relay': 'Ada' },
    });
    const ada = state.players.find((p) => p.id === 'Ada');
    assert.ok(ada);
    const withCash = { ...state, players: state.players.map((p) => (p.id === 'Ada' ? { ...p, cash: 80 } : p)) };
    const totalBefore = withCash.players.reduce((sum, p) => sum + p.cash, 0);

    const s1 = applyOk(withCash, 'MORTGAGE', { payload: { spaceId: 'foundry-anvil' } }).state;
    const s2 = applyOk(s1, 'MORTGAGE', { payload: { spaceId: 'hub-central-relay' } }).state;
    assert.equal(cashOf(s2, 'Ada'), 230);

    const beforeSettle = s2.players.reduce((sum, p) => sum + p.cash, 0);
    const { state: s3 } = applyOk(s2, 'SETTLE_DEBT');
    assert.equal(cashOf(s3, 'Ada'), 80);
    assert.equal(cashOf(s3, 'Grace'), 1650);
    assert.equal(s3.debt, null);
    assert.equal(s3.turnPhase, 'TURN_MANAGEMENT');
    // The settle step itself is a pure transfer: liquidation proceeds are
    // bank payouts, so player-cash conservation holds for SETTLE_DEBT only.
    assert.equal(s3.players.reduce((sum, p) => sum + p.cash, 0), beforeSettle, 'the settle step conserves money');
  });

  it('applies an idempotent duplicate exactly once', () => {
    const state = debtState({ owners: { 'foundry-anvil': 'Ada' } });
    const first = applyOk(state, 'MORTGAGE', { commandId: 'mort-1', payload: { spaceId: 'foundry-anvil' } });
    const cashAfterFirst = cashOf(first.state, 'Ada');

    const retry = applyCommand(first.state, makeCommand(first.state, 'MORTGAGE', { commandId: 'mort-1', payload: { spaceId: 'foundry-anvil' } }), rngForState(first.state.rngState));
    assert.ok(retry.ok);
    if (retry.ok) {
      assert.equal(retry.applied, false);
      assert.equal(cashOf(retry.state, 'Ada'), cashAfterFirst, 'no double proceeds');
      assert.equal(retry.state.mortgaged['foundry-anvil'], true);
    }
  });
});

// ---------------------------------------------------------------------------
// Settlement invariants and the §17.2 negative contract

describe('settlement invariants', () => {
  it('the emitted event stream never contains a bankruptcy event', () => {
    const withCashState = withCash(debtState({
      owners: { 'foundry-anvil': 'Ada', 'hub-central-relay': 'Ada' },
      upgrades: { 'foundry-anvil': 2 },
    }), 'Ada', 20);

    // Full liquidation: 2 sell-backs + 2 mortgages + settle — accumulate the
    // whole flow's event stream, not just the final command's.
    const r1 = applyOk(withCashState, 'SELL_UPGRADE', { payload: { spaceId: 'foundry-anvil' } });
    const r2 = applyOk(r1.state, 'SELL_UPGRADE', { payload: { spaceId: 'foundry-anvil' } });
    const r3 = applyOk(r2.state, 'MORTGAGE', { payload: { spaceId: 'foundry-anvil' } });
    const r4 = applyOk(r3.state, 'MORTGAGE', { payload: { spaceId: 'hub-central-relay' } });
    const r5 = applyOk(r4.state, 'SETTLE_DEBT');
    const events = [...r1.events, ...r2.events, ...r3.events, ...r4.events, ...r5.events];

    const banned: readonly string[] = ['PLAYER_BANKRUPT', 'PLAYER_ELIMINATED', 'ASSETS_TRANSFERRED'];
    for (const type of eventTypes(events)) {
      assert.equal(banned.includes(type), false, `${type} must never be emitted by this build`);
    }
    // The settlement surface's whole vocabulary, pinned explicitly.
    assert.deepEqual(eventTypes(events).sort(), ['DEBT_SETTLED', 'MORTGAGE_TAKEN', 'MORTGAGE_TAKEN', 'UPGRADE_SOLD', 'UPGRADE_SOLD']);
  });

  it('the settleable path never reaches ELIMINATION_AUCTIONS (elimination lives behind SURRENDER, PR 8)', () => {
    const state = debtState({
      owners: { 'foundry-anvil': 'Ada' },
      upgrades: { 'foundry-anvil': 2 },
    });
    const ada = state.players.find((p) => p.id === 'Ada');
    assert.ok(ada);
    const withCash = { ...state, players: state.players.map((p) => (p.id === 'Ada' ? { ...p, cash: 100 } : p)) };

    let current: GameState = withCash;
    for (const step of [
      { type: 'SELL_UPGRADE' as const, payload: { spaceId: 'foundry-anvil' } },
      { type: 'SELL_UPGRADE' as const, payload: { spaceId: 'foundry-anvil' } },
      { type: 'SETTLE_DEBT' as const, payload: {} },
      { type: 'END_TURN' as const, payload: {} },
    ]) {
      const { state: next } = applyOk(current, step.type, { payload: step.payload });
      assert.notEqual(next.turnPhase, 'ELIMINATION_AUCTIONS', 'no command may reach the elimination phase');
      current = next;
    }
  });

  it('maximum recoverable counts sell-backs and the unmortgaged payout together', () => {
    // Anvil $100: 2 levels → 2 × $25 sell-back; unmortgaged → +$50 mortgage.
    const leveled = debtState({ owners: { 'foundry-anvil': 'Ada' }, upgrades: { 'foundry-anvil': 2 } });
    assert.equal(maxLiquidationValue(leveled, 'Ada'), 100);

    const mortgaged = debtState({
      owners: { 'foundry-anvil': 'Ada' },
      upgrades: { 'foundry-anvil': 2 },
      mortgaged: { 'foundry-anvil': true },
    });
    assert.equal(maxLiquidationValue(mortgaged, 'Ada'), 50, 'a mortgaged space contributes only its sell-backs');

    const bare = debtState({ owners: { 'foundry-anvil': 'Ada' } });
    assert.equal(maxLiquidationValue(bare, 'Ada'), 50);
  });

  it('the exact boundary — cash plus maximum liquidation equal to the due amount is settleable', () => {
    const state = debtState({ owners: { 'foundry-anvil': 'Ada' }, upgrades: { 'foundry-anvil': 2 } });
    const ada = state.players.find((p) => p.id === 'Ada');
    assert.ok(ada);
    // $0 cash + $100 liquidation = $100 < $150.
    const short = { ...state, players: state.players.map((p) => (p.id === 'Ada' ? { ...p, cash: 0 } : p)) };
    assert.equal(isDebtHopeless(short, RENT_DUE), true);

    // $50 cash + $100 liquidation = $150 exactly — recoverable.
    const exact = { ...state, players: state.players.map((p) => (p.id === 'Ada' ? { ...p, cash: 50 } : p)) };
    assert.equal(isDebtHopeless(exact, RENT_DUE), false);
    const s1 = applyOk(exact, 'SELL_UPGRADE', { payload: { spaceId: 'foundry-anvil' } }).state;
    const s2 = applyOk(s1, 'SELL_UPGRADE', { payload: { spaceId: 'foundry-anvil' } }).state;
    const s3 = applyOk(s2, 'MORTGAGE', { payload: { spaceId: 'foundry-anvil' } }).state;
    const { state: s4 } = applyOk(s3, 'SETTLE_DEBT');
    assert.equal(s4.debt, null);
    assert.equal(cashOf(s4, 'Ada'), 0);
  });
});

// ---------------------------------------------------------------------------
// §17.2 type-level negative: the settlement surface structurally cannot emit
// bankruptcy events. Widening either union with a banned member flips the
// annotated constant to false — a compile error, not just a test failure.
// PR 8 lifted the RUNTIME ban: hopeless debts resolve through the waterfall
// in engine/endgame.ts, which owns the bankruptcy event types (pinned there).
// The structural ban on these two PR 5 unions remains by design.

type BannedEventType = 'PLAYER_BANKRUPT' | 'PLAYER_ELIMINATED' | 'ASSETS_TRANSFERRED';
type SettlementBanHolds = Extract<SettlementEventInput['type'], BannedEventType> extends never ? true : false;
type EconomyBanHolds = Extract<EconomyEventInput['type'], BannedEventType> extends never ? true : false;

const settlementBanHolds: SettlementBanHolds = true;
const economyBanHolds: EconomyBanHolds = true;

describe('type-level event ban (§17.2)', () => {
  it('excludes the bankruptcy vocabulary from the PR 5 event unions at compile time', () => {
    assert.equal(settlementBanHolds, true, 'SettlementEventInput must exclude bankruptcy events');
    assert.equal(economyBanHolds, true, 'EconomyEventInput must exclude bankruptcy events');
  });
});
