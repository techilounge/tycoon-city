import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CommandType, GameCommand } from '../../src/lib/game/commands';
import type { AnyGameEvent } from '../../src/lib/game/events';
import { applyCommand } from '../../src/lib/game/engine/reducer';
import { rngForState } from '../../src/lib/game/rng';
import { MAX_UPGRADE_LEVEL } from '../../src/lib/game/rules-v1';
import { RULES_VERSION, type GameState, type PlayerId, type PlayerState } from '../../src/lib/game/types';

// ---------------------------------------------------------------------------
// Helpers (per-file copy of the established turn-machine pattern)

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

function applyOk(
  state: GameState,
  type: CommandType,
  opts: { actor?: PlayerId; payload?: Record<string, unknown>; commandId?: string } = {},
): { state: GameState; events: readonly AnyGameEvent[] } {
  const result = applyCommand(state, makeCommand(state, type, opts), rngForState(state.rngState));
  assert.ok(result.ok, `${type} must apply: ${result.ok ? '' : result.error.message}`);
  if (!result.ok) throw new Error('unreachable');
  return result;
}

function applyErrCode(
  state: GameState,
  type: CommandType,
  opts: { actor?: PlayerId; payload?: Record<string, unknown>; commandId?: string } = {},
): string {
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

/** Hand-build a TURN_MANAGEMENT state. Foundry Row is the cheapest district:
 *  Smeltery $60 (build $30, sell-back $15), Brasshouse $80, Anvil $100. */
function mgmtState(
  overrides: {
    players?: PlayerState[];
    activePlayerId?: PlayerId | null;
    turnPhase?: GameState['turnPhase'];
    owners?: Record<string, PlayerId>;
    upgrades?: Record<string, number>;
    mortgaged?: Record<string, boolean>;
    processedCommandIds?: string[];
  } = {},
): GameState {
  return {
    gameId: 'g-dev',
    version: 7,
    phase: 'PLAYING',
    turnPhase: overrides.turnPhase ?? 'TURN_MANAGEMENT',
    mode: 'CLASSIC',
    doublesCount: 0,
    owners: overrides.owners ?? {
      'foundry-smeltery': 'Ada',
      'foundry-brasshouse': 'Ada',
      'foundry-anvil': 'Ada',
    },
    upgrades: overrides.upgrades ?? {},
    mortgaged: overrides.mortgaged ?? {},
    eventDeck: { drawPile: [], discardPile: [] },
    debt: null,
    auction: null,
    trade: null,
    estateSale: null,
    rulesVersion: RULES_VERSION,
    seed: 1,
    rngState: 1,
    players: overrides.players ?? [mkPlayer({ id: 'Ada', seat: 0 }), mkPlayer({ id: 'Grace', seat: 1 })],
    activePlayerId: overrides.activePlayerId ?? overrides.players?.[0]?.id ?? 'Ada',
    turn: 3,
    round: 1,
    lastEventSequence: 10,
    processedCommandIds: overrides.processedCommandIds ?? [],
  } as GameState;
}

function cashOf(state: GameState, id: PlayerId): number {
  const player = state.players.find((p) => p.id === id);
  assert.ok(player, `player ${id} must exist`);
  return player.cash;
}

const BUILD_SMELTERY = { payload: { spaceId: 'foundry-smeltery' } };
const BUILD_ANVIL = { payload: { spaceId: 'foundry-anvil' } };

describe('development — BUILD (spec §4 row 9, §8)', () => {
  it('builds one level at 50% of list price and emits UPGRADE_BUILT', () => {
    const state = mgmtState();
    const result = applyOk(state, 'BUILD', BUILD_SMELTERY);
    assert.deepEqual(result.events.map((e) => e.type), ['UPGRADE_BUILT']);
    const built = result.events[0];
    assert.ok(built.type === 'UPGRADE_BUILT');
    assert.deepEqual(built.payload, { playerId: 'Ada', spaceId: 'foundry-smeltery', level: 1, cost: 30 });
    assert.equal(cashOf(result.state, 'Ada'), 1500 - 30);
    assert.equal(result.state.upgrades['foundry-smeltery'], 1);
    assert.equal(result.state.turnPhase, 'TURN_MANAGEMENT', 'BUILD stays in management');
  });

  it('refuses to build without owning the complete district', () => {
    const state = mgmtState({ owners: { 'foundry-smeltery': 'Ada', 'foundry-brasshouse': 'Grace', 'foundry-anvil': 'Ada' } });
    assert.equal(applyErrCode(state, 'BUILD', BUILD_SMELTERY), 'RULE_VIOLATION');
  });

  it('refuses to build on mortgaged collateral', () => {
    const state = mgmtState({ mortgaged: { 'foundry-smeltery': true } });
    assert.equal(applyErrCode(state, 'BUILD', BUILD_SMELTERY), 'RULE_VIOLATION');
  });

  it(`refuses to build beyond the landmark (level ${4})`, () => {
    const state = mgmtState({ upgrades: { 'foundry-smeltery': MAX_UPGRADE_LEVEL } });
    assert.equal(applyErrCode(state, 'BUILD', BUILD_SMELTERY), 'RULE_VIOLATION');
  });

  it('refuses to build without cash backing (INSUFFICIENT_RESOURCES)', () => {
    const state = mgmtState({ players: [mkPlayer({ id: 'Ada', seat: 0, cash: 29 }), mkPlayer({ id: 'Grace', seat: 1 })] });
    assert.equal(applyErrCode(state, 'BUILD', BUILD_SMELTERY), 'INSUFFICIENT_RESOURCES');
  });

  it('refuses to build on hubs and services — only district properties develop', () => {
    const state = mgmtState({ owners: { 'hub-central-relay': 'Ada' } });
    assert.equal(applyErrCode(state, 'BUILD', { payload: { spaceId: 'hub-central-relay' } }), 'RULE_VIOLATION');
  });

  it('refuses another player\u2019s property and a non-owner actor', () => {
    const state = mgmtState({ owners: { 'foundry-smeltery': 'Grace', 'foundry-brasshouse': 'Grace', 'foundry-anvil': 'Grace' } });
    assert.equal(applyErrCode(state, 'BUILD', BUILD_SMELTERY), 'RULE_VIOLATION');
    const owned = mgmtState();
    assert.equal(applyErrCode(owned, 'BUILD', { ...BUILD_ANVIL, actor: 'Grace' }), 'NOT_AUTHORIZED');
  });

  it('is phase-gated to TURN_MANAGEMENT', () => {
    const state = mgmtState({ turnPhase: 'AWAITING_ROLL' });
    assert.equal(applyErrCode(state, 'BUILD', BUILD_SMELTERY), 'INVALID_PHASE');
  });

  it('is idempotent — a replayed commandId applies exactly once', () => {
    const first = applyOk(mgmtState(), 'BUILD', { ...BUILD_SMELTERY, commandId: 'cmd-dup' });
    assert.equal(first.state.upgrades['foundry-smeltery'], 1);
    const replayed = applyCommand(first.state, makeCommand(first.state, 'BUILD', { ...BUILD_SMELTERY, commandId: 'cmd-dup' }), rngForState(first.state.rngState));
    assert.ok(replayed.ok, 'the duplicate must resolve (idempotent), not error');
    if (!replayed.ok) return;
    assert.deepEqual(replayed.events, [], 'no events on the idempotent replay');
    assert.equal(cashOf(replayed.state, 'Ada'), cashOf(first.state, 'Ada'), 'cash charged once');
    assert.equal(replayed.state.upgrades['foundry-smeltery'], 1, 'level unchanged by the replay');
  });
});

describe('development — SELL_UPGRADE in TURN_MANAGEMENT (spec §7 sell-back)', () => {
  it('sells one level back at 50% of the price paid', () => {
    const state = mgmtState({ upgrades: { 'foundry-smeltery': 2 } });
    const result = applyOk(state, 'SELL_UPGRADE', BUILD_SMELTERY);
    assert.deepEqual(result.events.map((e) => e.type), ['UPGRADE_SOLD']);
    const sold = result.events[0];
    assert.ok(sold.type === 'UPGRADE_SOLD');
    assert.deepEqual(sold.payload, { playerId: 'Ada', spaceId: 'foundry-smeltery', level: 1, proceeds: 15 });
    assert.equal(cashOf(result.state, 'Ada'), 1500 + 15);
  });

  it('refuses to sell from an unbuilt property', () => {
    const state = mgmtState();
    assert.equal(applyErrCode(state, 'SELL_UPGRADE', BUILD_SMELTERY), 'RULE_VIOLATION');
  });

  it('build-then-sell round trip prices salvage at 50% of spend', () => {
    // Build two levels on the Anvil ($50 each), sell both ($25 each): the
    // cycle costs exactly one build level of value — 50% of total spend.
    const b1 = applyOk(mgmtState(), 'BUILD', BUILD_ANVIL);
    const b2 = applyOk(b1.state, 'BUILD', BUILD_ANVIL);
    assert.equal(cashOf(b2.state, 'Ada'), 1500 - 50 - 50);
    const s1 = applyOk(b2.state, 'SELL_UPGRADE', BUILD_ANVIL);
    const s2 = applyOk(s1.state, 'SELL_UPGRADE', BUILD_ANVIL);
    assert.equal(cashOf(s2.state, 'Ada'), 1500 - 50);
    assert.equal(s2.state.upgrades['foundry-anvil'], 0);
  });
});

describe('development — MORTGAGE and UNMORTGAGE (spec §8)', () => {
  it('mortgages a level-0 space for 50% of list price — hubs included', () => {
    const state = mgmtState({ owners: { 'hub-central-relay': 'Ada' } });
    const result = applyOk(state, 'MORTGAGE', { payload: { spaceId: 'hub-central-relay' } });
    assert.deepEqual(result.events.map((e) => e.type), ['MORTGAGE_TAKEN']);
    const taken = result.events[0];
    assert.ok(taken.type === 'MORTGAGE_TAKEN');
    assert.deepEqual(taken.payload, { playerId: 'Ada', spaceId: 'hub-central-relay', proceeds: 100 });
    assert.equal(cashOf(result.state, 'Ada'), 1500 + 100);
    assert.equal(result.state.mortgaged['hub-central-relay'], true);
  });

  it('refuses mortgaging a developed property and a double mortgage', () => {
    const developed = mgmtState({ upgrades: { 'foundry-smeltery': 1 } });
    assert.equal(applyErrCode(developed, 'MORTGAGE', BUILD_SMELTERY), 'RULE_VIOLATION');
    const mortgaged = mgmtState({ mortgaged: { 'foundry-smeltery': true } });
    assert.equal(applyErrCode(mortgaged, 'MORTGAGE', BUILD_SMELTERY), 'RULE_VIOLATION');
  });

  it('lifts a mortgage for 110% of list price and re-enables the space', () => {
    const state = mgmtState({ mortgaged: { 'foundry-anvil': true } });
    const result = applyOk(state, 'UNMORTGAGE', BUILD_ANVIL);
    assert.deepEqual(result.events.map((e) => e.type), ['MORTGAGE_LIFTED']);
    const lifted = result.events[0];
    assert.ok(lifted.type === 'MORTGAGE_LIFTED');
    assert.deepEqual(lifted.payload, { playerId: 'Ada', spaceId: 'foundry-anvil', cost: 110 });
    assert.equal(cashOf(result.state, 'Ada'), 1500 - 110);
    assert.equal('foundry-anvil' in result.state.mortgaged, false, 'the mortgage flag is cleared');
  });

  it('refuses lifting a mortgage that is not there, and short cash', () => {
    const state = mgmtState();
    assert.equal(applyErrCode(state, 'UNMORTGAGE', BUILD_ANVIL), 'RULE_VIOLATION');
    const poor = mgmtState({ players: [mkPlayer({ id: 'Ada', seat: 0, cash: 109 }), mkPlayer({ id: 'Grace', seat: 1 })], mortgaged: { 'foundry-anvil': true } });
    assert.equal(applyErrCode(poor, 'UNMORTGAGE', BUILD_ANVIL), 'INSUFFICIENT_RESOURCES');
  });

  it('development commands are phase-gated (MORTGAGE and UNMORTGAGE)', () => {
    const rolling = mgmtState({ turnPhase: 'AWAITING_ROLL' });
    assert.equal(applyErrCode(rolling, 'MORTGAGE', BUILD_SMELTERY), 'INVALID_PHASE');
    assert.equal(applyErrCode(rolling, 'UNMORTGAGE', BUILD_ANVIL), 'INVALID_PHASE');
    assert.equal(applyErrCode(rolling, 'SELL_UPGRADE', BUILD_SMELTERY), 'INVALID_PHASE');
  });
});
