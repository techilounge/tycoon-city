import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CommandType, GameCommand } from '../../src/lib/game/commands';
import type { AnyGameEvent } from '../../src/lib/game/events';
import { applyCommand } from '../../src/lib/game/engine/reducer';
import { replayCommands, stateHash } from '../../src/lib/game/engine/replay';
import { rngForState } from '../../src/lib/game/rng';
import { buildSnapshot, parseSnapshot, serializeSnapshot } from '../../src/lib/game/snapshot-schema';
import type { TradeEventInput } from '../../src/lib/game/engine/trading';
import { BANK_ID, RULES_VERSION, type DebtState, type GameState, type PendingTradeState, type PlayerId, type PlayerState, type TradeOffer } from '../../src/lib/game/types';

// ---------------------------------------------------------------------------
// Helpers (per-file copies of the established debt/turn-machine pattern)

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

function applyErrCode(state: GameState, type: CommandType, opts: { actor?: PlayerId; payload?: Record<string, unknown>; commandId?: string; expectedVersion?: number } = {}): string {
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
  } as PlayerState;
}

/** Hand-build a PLAYING state for trade fixtures (default: Ada's management phase). */
function craftedState(overrides: {
  players?: PlayerState[];
  activePlayerId?: PlayerId | null;
  turnPhase?: GameState['turnPhase'];
  phase?: GameState['phase'];
  rngState?: number;
  doublesCount?: number;
  turn?: number;
  owners?: Record<string, PlayerId>;
  upgrades?: Record<string, number>;
  mortgaged?: Record<string, boolean>;
  debt?: DebtState;
  trade?: GameState['trade'];
  processedCommandIds?: string[];
} = {}): GameState {
  return {
    gameId: 'g-trade',
    version: 7,
    phase: overrides.phase ?? 'PLAYING',
    turnPhase: overrides.turnPhase ?? 'TURN_MANAGEMENT',
    mode: 'CLASSIC',
    doublesCount: overrides.doublesCount ?? 0,
    owners: overrides.owners ?? {},
    upgrades: overrides.upgrades ?? {},
    mortgaged: overrides.mortgaged ?? {},
    eventDeck: { drawPile: [], discardPile: [] },
    debt: overrides.debt ?? null,
    auction: null,
    trade: overrides.trade ?? null,
    rulesVersion: RULES_VERSION,
    seed: 1,
    rngState: overrides.rngState ?? 1,
    players: overrides.players ?? [mkPlayer({ id: 'Ada', seat: 0 }), mkPlayer({ id: 'Grace', seat: 1 })],
    activePlayerId: overrides.activePlayerId ?? overrides.players?.[0]?.id ?? 'Ada',
    turn: overrides.turn ?? 3,
    lastEventSequence: 10,
    processedCommandIds: overrides.processedCommandIds ?? [],
  } as GameState;
}

/** Ada offers to buy Grace's foundry-smeltery for $150 — the plain trade. */
const SMELTERY = 'foundry-smeltery';
function smelteryOffer(): TradeOffer {
  return { give: { cash: 150, spaceIds: [] }, receive: { cash: 0, spaceIds: [SMELTERY] } };
}

/** A pending offer shaped like one `smelteryOffer` produced (deterministic id). */
function pendingSmelteryTrade(overrides: Partial<PendingTradeState> = {}): PendingTradeState {
  return {
    tradeId: 'trade-11',
    proposerId: 'Ada',
    recipientId: 'Grace',
    offer: smelteryOffer(),
    anchorTurn: 3,
    ...overrides,
  };
}

/** A settling state: Ada owes the bank $150 rent and may trade out of it (D-6). */
function settlingState(overrides: { players?: PlayerState[]; owners?: Record<string, PlayerId>; trade?: GameState['trade'] } = {}): GameState {
  return craftedState({
    ...overrides,
    turnPhase: 'SETTLING_DEBT',
    debt: { debtorId: 'Ada', creditorId: BANK_ID, amountDue: 150, reason: 'RENT' },
  });
}

function cashOf(state: GameState, id: PlayerId): number {
  const player = state.players.find((p) => p.id === id);
  assert.ok(player, `player ${id} must exist`);
  return player.cash;
}

function ownerOf(state: GameState, spaceId: string): PlayerId | null {
  return state.owners[spaceId] ?? null;
}

function eventTypes(events: readonly AnyGameEvent[]): string[] {
  return events.map((e) => e.type);
}

/** Roll the pair a given seed's ROLL would draw (spec §3 draw order: die1, die2). */
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

// ---------------------------------------------------------------------------
// Row 10 — proposing (spec §6)

describe('OFFER_TRADE — proposing (spec §4 row 10)', () => {
  it('a valid offer parks one pending trade anchored to the current turn', () => {
    const state = craftedState({ owners: { [SMELTERY]: 'Grace' } });
    const { state: s1, events } = applyOk(state, 'OFFER_TRADE', { payload: { recipientId: 'Grace', offer: smelteryOffer() } });

    assert.deepEqual(eventTypes(events), ['TRADE_OFFERED']);
    const trade = s1.trade;
    assert.ok(trade, 'the offer is pending');
    assert.equal(trade.tradeId, 'trade-11', 'the id derives from the TRADE_OFFERED sequence');
    assert.equal(trade.proposerId, 'Ada');
    assert.equal(trade.recipientId, 'Grace');
    assert.deepEqual(trade.offer, smelteryOffer());
    assert.equal(trade.anchorTurn, 3, 'a fresh offer is anchored to the proposer’s current turn');
    assert.equal(s1.turnPhase, 'TURN_MANAGEMENT', 'offering does not end the management phase');
  });

  it('a non-active player cannot propose', () => {
    const state = craftedState({ owners: { [SMELTERY]: 'Grace' } });
    assert.equal(applyErrCode(state, 'OFFER_TRADE', { actor: 'Grace', payload: { recipientId: 'Ada', offer: smelteryOffer() } }), 'NOT_AUTHORIZED');
  });

  it('offering is illegal outside TURN_MANAGEMENT and SETTLING_DEBT', () => {
    const owners = { [SMELTERY]: 'Grace' };
    assert.equal(applyErrCode(craftedState({ owners, turnPhase: 'AWAITING_ROLL' }), 'OFFER_TRADE', { payload: { recipientId: 'Grace', offer: smelteryOffer() } }), 'INVALID_PHASE');
    const rolled = applyOk(craftedState({ owners, turnPhase: 'AWAITING_ROLL' }), 'ROLL').state;
    assert.equal(applyErrCode(rolled, 'OFFER_TRADE', { payload: { recipientId: 'Grace', offer: smelteryOffer() } }), 'INVALID_PHASE');
  });

  it('a proposal while an offer is pending is rejected — one offer at a time', () => {
    const state = craftedState({ owners: { [SMELTERY]: 'Grace' } });
    const { state: s1 } = applyOk(state, 'OFFER_TRADE', { payload: { recipientId: 'Grace', offer: smelteryOffer() } });
    assert.equal(applyErrCode(s1, 'OFFER_TRADE', { payload: { recipientId: 'Grace', offer: smelteryOffer() } }), 'RULE_VIOLATION');
  });

  it('the recipient must be another live player', () => {
    const state = craftedState({});
    assert.equal(applyErrCode(state, 'OFFER_TRADE', { payload: { recipientId: 'Ada', offer: smelteryOffer() } }), 'RULE_VIOLATION');
    assert.equal(applyErrCode(state, 'OFFER_TRADE', { payload: { recipientId: 'mallory', offer: smelteryOffer() } }), 'RULE_VIOLATION');
  });

  it('the proposer must legally hold the give leg, the recipient the receive leg', () => {
    // Nobody owns foundry-brasshouse — Ada cannot give it.
    assert.equal(
      applyErrCode(craftedState({}), 'OFFER_TRADE', {
        payload: { recipientId: 'Grace', offer: { give: { cash: 0, spaceIds: ['foundry-brasshouse'] }, receive: { cash: 0, spaceIds: [] } } },
      }),
      'RULE_VIOLATION',
    );
    // Grace owns nothing — she cannot give the smeltery.
    assert.equal(applyErrCode(craftedState({}), 'OFFER_TRADE', { payload: { recipientId: 'Grace', offer: smelteryOffer() } }), 'RULE_VIOLATION');
  });

  it('one space cannot move twice within a swap', () => {
    // Ada owns both spaces and names the anvil on both legs.
    const state = craftedState({ owners: { 'foundry-anvil': 'Ada', 'foundry-brasshouse': 'Ada' } });
    assert.equal(
      applyErrCode(state, 'OFFER_TRADE', {
        payload: { recipientId: 'Grace', offer: { give: { cash: 0, spaceIds: ['foundry-anvil'] }, receive: { cash: 0, spaceIds: ['foundry-anvil'] } } },
      }),
      'RULE_VIOLATION',
    );
  });

  it('trade cash is whole dollars', () => {
    const state = craftedState({ owners: { [SMELTERY]: 'Grace' } });
    assert.equal(
      applyErrCode(state, 'OFFER_TRADE', {
        payload: { recipientId: 'Grace', offer: { give: { cash: 150.5, spaceIds: [] }, receive: { cash: 0, spaceIds: [SMELTERY] } } },
      }),
      'RULE_VIOLATION',
    );
  });
});

// ---------------------------------------------------------------------------
// Row 10 — answering (recipient-only, any phase while pending)

describe('ANSWER_TRADE — recipient-only answers (spec §6)', () => {
  it('only the designated recipient may answer — the proposer cannot', () => {
    const state = craftedState({ owners: { [SMELTERY]: 'Grace' } });
    const { state: s1 } = applyOk(state, 'OFFER_TRADE', { payload: { recipientId: 'Grace', offer: smelteryOffer() } });
    assert.equal(applyErrCode(s1, 'ANSWER_TRADE', { actor: 'Ada', payload: { tradeId: 'trade-11', response: 'REJECT' } }), 'NOT_AUTHORIZED');
  });

  it('a REJECT clears the offer and moves nothing', () => {
    const state = craftedState({ owners: { [SMELTERY]: 'Grace' } });
    const { state: s1 } = applyOk(state, 'OFFER_TRADE', { payload: { recipientId: 'Grace', offer: smelteryOffer() } });
    const before = structuredClone(s1);

    const { state: s2, events } = applyOk(s1, 'ANSWER_TRADE', { actor: 'Grace', payload: { tradeId: 'trade-11', response: 'REJECT' } });

    assert.deepEqual(eventTypes(events), ['TRADE_ANSWERED']);
    assert.equal(s2.trade, null);
    assert.deepEqual(s2.owners, before.owners, 'a rejected trade moves no ownership');
    assert.equal(cashOf(s2, 'Ada'), cashOf(before, 'Ada'));
    assert.equal(cashOf(s2, 'Grace'), cashOf(before, 'Grace'));
  });

  it('an answer naming a stale tradeId is rejected', () => {
    const state = craftedState({ owners: { [SMELTERY]: 'Grace' }, trade: pendingSmelteryTrade() });
    assert.equal(applyErrCode(state, 'ANSWER_TRADE', { actor: 'Grace', payload: { tradeId: 'trade-bogus', response: 'REJECT' } }), 'RULE_VIOLATION');
  });

  it('a recipient answers during another player’s turn without disturbing it', () => {
    // A pending counter whose proposer is Grace (recipient Ada) while ADA
    // is the active player mid-turn: the answer is legal in any phase while
    // the offer pends, and the active player's turn state must not move.
    const state = craftedState({
      turnPhase: 'AWAITING_ROLL',
      turn: 5,
      trade: pendingSmelteryTrade({ proposerId: 'Grace', recipientId: 'Ada', anchorTurn: 5 }),
    });
    const { state: s2, events } = applyOk(state, 'ANSWER_TRADE', { actor: 'Ada', payload: { tradeId: 'trade-11', response: 'REJECT' } });

    assert.deepEqual(eventTypes(events), ['TRADE_ANSWERED']);
    assert.equal(s2.trade, null);
    assert.equal(s2.activePlayerId, 'Ada', 'the answering player’s turn is untouched');
    assert.equal(s2.turnPhase, 'AWAITING_ROLL');
    assert.equal(s2.turn, 5);
  });
});

// ---------------------------------------------------------------------------
// Acceptance — the atomic swap (spec §6)

describe('ANSWER_TRADE — acceptance is an atomic swap (spec §6)', () => {
  it('a cash-for-property acceptance moves cash and ownership in one transition', () => {
    const state = craftedState({ owners: { [SMELTERY]: 'Grace' } });
    const { state: s1 } = applyOk(state, 'OFFER_TRADE', { payload: { recipientId: 'Grace', offer: smelteryOffer() } });

    const { state: s2, events } = applyOk(s1, 'ANSWER_TRADE', { actor: 'Grace', payload: { tradeId: 'trade-11', response: 'ACCEPT' } });

    assert.deepEqual(eventTypes(events), ['TRADE_ANSWERED']);
    assert.equal(cashOf(s2, 'Ada'), 1500 - 150, 'the proposer paid the give cash');
    assert.equal(cashOf(s2, 'Grace'), 1500 + 150, 'the recipient received it');
    assert.equal(ownerOf(s2, SMELTERY), 'Ada');
    assert.equal(s2.trade, null, 'no offer survives acceptance');
  });

  it('multi-space legs swap together — assets ride as one atomic packet', () => {
    const state = craftedState({
      owners: { 'foundry-anvil': 'Ada', 'foundry-brasshouse': 'Ada', [SMELTERY]: 'Grace' } as Record<string, PlayerId>,
      trade: {
        tradeId: 'trade-11',
        proposerId: 'Ada',
        recipientId: 'Grace',
        offer: { give: { cash: 0, spaceIds: ['foundry-anvil', 'foundry-brasshouse'] }, receive: { cash: 30, spaceIds: [SMELTERY] } },
        anchorTurn: 3,
      },
    });
    const before = structuredClone(state);

    const { state: s2, events } = applyOk(state, 'ANSWER_TRADE', { actor: 'Grace', payload: { tradeId: 'trade-11', response: 'ACCEPT' } });

    assert.deepEqual(eventTypes(events), ['TRADE_ANSWERED']);
    assert.equal(cashOf(s2, 'Ada'), 1500 + 30);
    assert.equal(cashOf(s2, 'Grace'), 1500 - 30);
    assert.equal(ownerOf(s2, 'foundry-anvil'), 'Grace');
    assert.equal(ownerOf(s2, 'foundry-brasshouse'), 'Grace');
    assert.equal(ownerOf(s2, SMELTERY), 'Ada');
    assert.equal(s2.trade, null);
    assert.deepEqual(s2.upgrades, before.upgrades, 'nothing outside the swap moved');
  });

  it('a mortgaged space rides with the trade — the transferee pays the 110% unlock later', () => {
    const state = craftedState({
      owners: { [SMELTERY]: 'Grace' },
      mortgaged: { [SMELTERY]: true },
      trade: pendingSmelteryTrade(),
    });

    const { state: s2 } = applyOk(state, 'ANSWER_TRADE', { actor: 'Grace', payload: { tradeId: 'trade-11', response: 'ACCEPT' } });

    assert.equal(ownerOf(s2, SMELTERY), 'Ada');
    assert.equal(s2.mortgaged[SMELTERY], true, 'the mortgage flag transfers intact');
  });

  it('acceptance re-validates ownership against current state — a stale offer cannot move what the giver no longer holds', () => {
    // The pending offer names the smeltery as Ada's give; Ada does not hold
    // it (as if state drifted since the counter was made).
    const state = craftedState({
      trade: {
        tradeId: 'trade-11',
        proposerId: 'Ada',
        recipientId: 'Grace',
        offer: { give: { cash: 0, spaceIds: [SMELTERY] }, receive: { cash: 100, spaceIds: [] } },
        anchorTurn: 3,
      },
    });
    const before = structuredClone(state);

    assert.equal(applyErrCode(state, 'ANSWER_TRADE', { actor: 'Grace', payload: { tradeId: 'trade-11', response: 'ACCEPT' } }), 'RULE_VIOLATION');
    assert.deepEqual(state, before, 'a failed acceptance leaves the state byte-identical');
  });

  it('no credit on either side — the transfer cannot overdraw giver or payer', () => {
    // The give leg is Ada's $2,000 against $1,500 cash.
    const overpaying = craftedState({
      trade: {
        tradeId: 'trade-11',
        proposerId: 'Ada',
        recipientId: 'Grace',
        offer: { give: { cash: 2000, spaceIds: [] }, receive: { cash: 0, spaceIds: [SMELTERY] } },
        anchorTurn: 3,
      },
      owners: { [SMELTERY]: 'Grace' },
    });
    assert.equal(applyErrCode(overpaying, 'ANSWER_TRADE', { actor: 'Grace', payload: { tradeId: 'trade-11', response: 'ACCEPT' } }), 'INSUFFICIENT_RESOURCES');

    // And the receive leg is Grace's $2,000 against $1,500.
    const overreceiving = craftedState({
      trade: {
        tradeId: 'trade-11',
        proposerId: 'Ada',
        recipientId: 'Grace',
        offer: { give: { cash: 0, spaceIds: [SMELTERY] }, receive: { cash: 2000, spaceIds: [] } },
        anchorTurn: 3,
      },
      owners: { [SMELTERY]: 'Ada' },
    });
    assert.equal(applyErrCode(overreceiving, 'ANSWER_TRADE', { actor: 'Grace', payload: { tradeId: 'trade-11', response: 'ACCEPT' } }), 'INSUFFICIENT_RESOURCES');
  });
});

// ---------------------------------------------------------------------------
// Counters — roles reverse, the offer is replaced (spec §6)

describe('counters — role reversal and replacement (spec §6)', () => {
  function offeredState(): GameState {
    return craftedState({ owners: { [SMELTERY]: 'Grace' } });
  }

  it('a counter reverses the roles, replaces the offer, and keeps its own id', () => {
    const { state: s1 } = applyOk(offeredState(), 'OFFER_TRADE', { payload: { recipientId: 'Grace', offer: smelteryOffer() } });
    const counter: TradeOffer = { give: { cash: 0, spaceIds: [SMELTERY] }, receive: { cash: 100, spaceIds: [] } };

    const { state: s2, events } = applyOk(s1, 'ANSWER_TRADE', { actor: 'Grace', payload: { tradeId: 'trade-11', response: 'COUNTER', counterOffer: counter } });

    // The answer names the replaced offer and points at its successor; the
    // counter's TRADE_OFFERED follows as the command's second event, and the
    // counter's id derives from its own TRADE_OFFERED sequence (the answer
    // itself consumed the one before it).
    assert.deepEqual(eventTypes(events), ['TRADE_ANSWERED', 'TRADE_OFFERED']);
    assert.deepEqual((events[0].payload as { counterTradeId?: string }).counterTradeId, 'trade-13', 'the counter id derives from its own TRADE_OFFERED sequence');
    const pending = s2.trade;
    assert.ok(pending, 'the counter is the one pending offer');
    assert.equal(pending.tradeId, 'trade-13');
    assert.equal(pending.proposerId, 'Grace', 'roles reversed');
    assert.equal(pending.recipientId, 'Ada');
    assert.deepEqual(pending.offer, counter);
    assert.equal(pending.anchorTurn, null, 'the counter anchors to the new proposer’s NEXT turn');
  });

  it('a counter without a counterOffer payload is a shape fault', () => {
    const { state: s1 } = applyOk(offeredState(), 'OFFER_TRADE', { payload: { recipientId: 'Grace', offer: smelteryOffer() } });
    assert.equal(applyErrCode(s1, 'ANSWER_TRADE', { actor: 'Grace', payload: { tradeId: 'trade-11', response: 'COUNTER' } }), 'INVALID_SHAPE');
  });

  it('a counter is validated like any offer — the responder must hold what they give', () => {
    const { state: s1 } = applyOk(offeredState(), 'OFFER_TRADE', { payload: { recipientId: 'Grace', offer: smelteryOffer() } });
    assert.equal(
      applyErrCode(s1, 'ANSWER_TRADE', {
        actor: 'Grace',
        payload: { tradeId: 'trade-11', response: 'COUNTER', counterOffer: { give: { cash: 0, spaceIds: ['foundry-anvil'] }, receive: { cash: 0, spaceIds: [] } } },
      }),
      'RULE_VIOLATION',
    );
  });

  it('the original proposer accepts the counter — the reversed swap applies atomically', () => {
    const { state: s1 } = applyOk(offeredState(), 'OFFER_TRADE', { payload: { recipientId: 'Grace', offer: smelteryOffer() } });
    const counter: TradeOffer = { give: { cash: 0, spaceIds: [SMELTERY] }, receive: { cash: 100, spaceIds: [] } };
    const { state: s2 } = applyOk(s1, 'ANSWER_TRADE', { actor: 'Grace', payload: { tradeId: 'trade-11', response: 'COUNTER', counterOffer: counter } });

    const { state: s3 } = applyOk(s2, 'ANSWER_TRADE', { actor: 'Ada', payload: { tradeId: 'trade-13', response: 'ACCEPT' } });

    // The counter has Grace giving the smeltery and receiving $100 — Ada
    // pays it and takes the property.
    assert.equal(cashOf(s3, 'Ada'), 1500 - 100, 'Ada pays the counter’s ask');
    assert.equal(cashOf(s3, 'Grace'), 1500 + 100);
    assert.equal(ownerOf(s3, SMELTERY), 'Ada');
    assert.equal(s3.trade, null);
  });
});

// ---------------------------------------------------------------------------
// Expiry — a pure turn-counter comparison (spec §6, no wall clock)

describe('expiry — offers die at the anchored turn’s end, never before (spec §6)', () => {
  it('a fresh offer expires when the proposer’s turn ends', () => {
    const state = craftedState({ owners: { [SMELTERY]: 'Grace' } });
    const { state: s1 } = applyOk(state, 'OFFER_TRADE', { payload: { recipientId: 'Grace', offer: smelteryOffer() } });

    const { state: s2, events } = applyOk(s1, 'END_TURN');

    const types = eventTypes(events);
    assert.equal(types.indexOf('TURN_ENDED') < types.indexOf('TRADE_EXPIRED'), true, 'the offer dies with its turn — TURN_ENDED first');
    assert.equal(types.indexOf('TRADE_EXPIRED') < types.indexOf('TURN_STARTED'), true, 'the expiry precedes the handover');
    assert.equal((events.find((e) => e.type === 'TRADE_EXPIRED')?.payload as { tradeId: string }).tradeId, 'trade-11');
    assert.equal(s2.trade, null);
    assert.equal(s2.activePlayerId, 'Grace');
  });

  it('a doubles extra cycle does NOT expire the offer — same ordinal, no turn pass', () => {
    // First roll doubles summing 4: Ada sits on 4 and lands on the park (8).
    const seed = findSeed(500, (s) => {
      const [a, b] = firstRoll(s);
      return a === b && a + b === 4;
    });
    const state = craftedState({
      turnPhase: 'AWAITING_ROLL',
      rngState: seed,
      players: [mkPlayer({ id: 'Ada', seat: 0, position: 4 }), mkPlayer({ id: 'Grace', seat: 1 })],
      owners: { [SMELTERY]: 'Grace' },
    });

    const rolled = applyOk(state, 'ROLL').state; // doubles → TURN_MANAGEMENT, counter 1
    assert.equal(rolled.doublesCount, 1);
    const offered = applyOk(rolled, 'OFFER_TRADE', { payload: { recipientId: 'Grace', offer: smelteryOffer() } }).state;
    const { state: after } = applyOk(offered, 'END_TURN');

    assert.equal(after.activePlayerId, 'Ada', 'doubles grant one extra cycle');
    assert.equal(after.turnPhase, 'AWAITING_ROLL');
    assert.equal(after.turn, 3, 'same turn ordinal');
    assert.ok(after.trade, 'the offer survives the extra cycle');
    assert.equal(after.trade?.anchorTurn, 3);
  });

  it('the offer then expires when that turn actually passes — not during its extra cycles', () => {
    // Seed 233 (probed): the extra cycle rolls 5+6 — Ada lands on the Night
    // Market (index 19; the fixture's Event deck is empty, so no effect) and
    // the turn resolves straight to management. The offer must survive that
    // second window of the SAME ordinal turn and die only at its handover.
    const state = craftedState({
      turnPhase: 'AWAITING_ROLL',
      rngState: 233,
      turn: 3,
      players: [mkPlayer({ id: 'Ada', seat: 0, position: 4 }), mkPlayer({ id: 'Grace', seat: 1 })],
      owners: { [SMELTERY]: 'Grace' },
    });

    const rolled = applyOk(state, 'ROLL').state; // [2,2] doubles → extra cycle
    const offered = applyOk(rolled, 'OFFER_TRADE', { payload: { recipientId: 'Grace', offer: smelteryOffer() } }).state;
    const cycled = applyOk(offered, 'END_TURN').state; // extra cycle, offer alive
    assert.ok(cycled.trade, 'precondition: the offer survived the extra cycle');
    assert.equal(cycled.activePlayerId, 'Ada');

    const landed = applyOk(cycled, 'ROLL').state; // [5,6] → 19, TURN_MANAGEMENT
    assert.equal(landed.turnPhase, 'TURN_MANAGEMENT');
    assert.ok(landed.trade, 'the offer survives a second management window of the same turn');

    const { state: passed } = applyOk(landed, 'END_TURN');
    assert.equal(passed.trade, null, 'the turn passed — the offer expired');
    assert.equal(passed.activePlayerId, 'Grace');
  });

  it('the third-doubles pass expires a pending offer (row 4 hands over too)', () => {
    const seed = findSeed(500, (s) => {
      const [a, b] = firstRoll(s);
      return a === b && a + b === 4;
    });
    const state = craftedState({
      turnPhase: 'AWAITING_ROLL',
      doublesCount: 2,
      rngState: seed,
      turn: 3,
      players: [mkPlayer({ id: 'Ada', seat: 0, position: 4 }), mkPlayer({ id: 'Grace', seat: 1 })],
      trade: pendingSmelteryTrade({ offer: { give: { cash: 0, spaceIds: [] }, receive: { cash: 0, spaceIds: [] } } }),
    });

    const { state: s1, events } = applyOk(state, 'ROLL');

    // Row 4: no movement by dice — the token relocates to the nearest park,
    // the turn ends without a management phase, and the handover expires the
    // offer. (TURN_SKIPPED itself fires later, when the skipped turn would
    // begin.)
    const types = eventTypes(events);
    assert.equal(types.includes('PLAYER_MOVED'), true, 'the token relocates to the nearest park');
    assert.equal(types.includes('TURN_ENDED'), true);
    assert.equal(types.includes('TRADE_EXPIRED'), true, 'the pass still expires the offer');
    assert.equal(s1.trade, null);
    assert.equal(s1.activePlayerId, 'Grace');
  });

  it('a HOLD pass expires a pending offer (row 2 hands over too)', () => {
    const state = craftedState({
      turnPhase: 'AWAITING_ROLL',
      trade: pendingSmelteryTrade({ offer: { give: { cash: 0, spaceIds: [] }, receive: { cash: 0, spaceIds: [] } } }),
      players: [mkPlayer({ id: 'Ada', seat: 0, tokens: { HOLD: 1, RENT_HOLIDAY: 0 } }), mkPlayer({ id: 'Grace', seat: 1 })],
    });

    const { state: s1, events } = applyOk(state, 'HOLD');

    assert.equal(eventTypes(events).includes('TRADE_EXPIRED'), true);
    assert.equal(s1.trade, null);
    assert.equal(s1.activePlayerId, 'Grace');
  });

  it('a counter expires at the END of the counter-proposer’s next turn — and survives everything before it', () => {
    // Three players: Ada offers Grace; Grace counters; Ada ends her turn
    // (the counter survives — it is anchored to GRACE's next turn); Grace's
    // turn begins (the anchor stamps) and ends — the counter dies there,
    // even though the turn passes onward to Bo.
    const seed = findSeed(500, (s) => {
      const [a, b] = firstRoll(s);
      return a + b === 4 && a !== b;
    });
    const state = craftedState({
      turn: 3,
      rngState: seed,
      players: [mkPlayer({ id: 'Ada', seat: 0 }), mkPlayer({ id: 'Grace', seat: 1, position: 4 }), mkPlayer({ id: 'Bo', seat: 2 })],
      owners: { [SMELTERY]: 'Grace' },
    });

    const { state: s1 } = applyOk(state, 'OFFER_TRADE', { payload: { recipientId: 'Grace', offer: smelteryOffer() } });
    const counter: TradeOffer = { give: { cash: 0, spaceIds: [SMELTERY] }, receive: { cash: 100, spaceIds: [] } };
    const { state: s2 } = applyOk(s1, 'ANSWER_TRADE', { actor: 'Grace', payload: { tradeId: 'trade-11', response: 'COUNTER', counterOffer: counter } });
    const { state: s3, events: adaEnd } = applyOk(s2, 'END_TURN');

    assert.equal(adaEnd.some((e) => e.type === 'TRADE_EXPIRED'), false, 'Ada’s turn end cannot kill Grace’s counter');
    assert.ok(s3.trade, 'the counter survived the original proposer’s turn end');
    assert.equal(s3.activePlayerId, 'Grace');
    assert.equal(s3.trade?.anchorTurn, 4, 'the anchor stamped when the counter-proposer’s turn began');

    const graceRolled = applyOk(s3, 'ROLL').state; // 1+3 → the park at 8
    const { state: s4, events: graceEnd } = applyOk(graceRolled, 'END_TURN');

    assert.equal(graceEnd.some((e) => e.type === 'TRADE_EXPIRED'), true, 'Grace’s turn end expires her counter');
    assert.equal(s4.trade, null);
    assert.equal(s4.activePlayerId, 'Bo', 'the turn passed onward — the expiry rode the same handover');
  });
});

// ---------------------------------------------------------------------------
// Settlement-phase trades (row 13, Decision D-6)

describe('trades during debt settlement (spec §7, Decision D-6)', () => {
  it('the debtor proposes a trade out of debt and settles atomically after acceptance', () => {
    const state = settlingState({ owners: { 'foundry-anvil': 'Ada' } });
    const offer: TradeOffer = { give: { cash: 0, spaceIds: ['foundry-anvil'] }, receive: { cash: 200, spaceIds: [] } };

    const { state: s1 } = applyOk(state, 'OFFER_TRADE', { payload: { recipientId: 'Grace', offer } });
    assert.equal(s1.turnPhase, 'SETTLING_DEBT', 'proposing does not leave the settlement');
    assert.ok(s1.trade);

    const { state: s2 } = applyOk(s1, 'ANSWER_TRADE', { actor: 'Grace', payload: { tradeId: 'trade-11', response: 'ACCEPT' } });
    assert.equal(cashOf(s2, 'Ada'), 1500 + 200);
    assert.equal(ownerOf(s2, 'foundry-anvil'), 'Grace');

    const { state: s3, events } = applyOk(s2, 'SETTLE_DEBT');
    assert.equal(eventTypes(events).includes('DEBT_SETTLED'), true, 'the raised cash settles the debt');
    assert.equal(s3.debt, null);
    assert.equal(s3.turnPhase, 'TURN_MANAGEMENT');
    assert.equal(cashOf(s3, 'Ada'), 1700 - 150);
  });

  it('a non-active player cannot propose during another’s settlement', () => {
    const state = settlingState({ owners: { 'foundry-anvil': 'Ada' } });
    assert.equal(
      applyErrCode(state, 'OFFER_TRADE', {
        actor: 'Grace',
        payload: { recipientId: 'Ada', offer: { give: { cash: 100, spaceIds: [] }, receive: { cash: 0, spaceIds: ['foundry-anvil'] } } },
      }),
      'NOT_AUTHORIZED',
    );
  });

  it('the debtor answers a pending counter while settling', () => {
    // Grace's counter is pending (Ada its recipient) when Ada is in
    // settlement — the answer is still Ada's alone (any phase, D-6).
    const state = settlingState({
      trade: {
        tradeId: 'trade-11',
        proposerId: 'Grace',
        recipientId: 'Ada',
        offer: { give: { cash: 100, spaceIds: [] }, receive: { cash: 0, spaceIds: [] } },
        anchorTurn: null,
      },
    });
    assert.equal(applyErrCode(state, 'ANSWER_TRADE', { actor: 'Grace', payload: { tradeId: 'trade-11', response: 'REJECT' } }), 'NOT_AUTHORIZED');
    const { state: s1 } = applyOk(state, 'ANSWER_TRADE', { actor: 'Ada', payload: { tradeId: 'trade-11', response: 'ACCEPT' } });
    assert.equal(cashOf(s1, 'Ada'), 1500 + 100);
    assert.equal(s1.trade, null);
  });
});

// ---------------------------------------------------------------------------
// Snapshots (spec §2.4)

describe('snapshots of pending trades (spec §2.4)', () => {
  it('a pending anchored offer round-trips byte-equal', () => {
    const state = craftedState({ owners: { [SMELTERY]: 'Grace' } });
    const { state: s1 } = applyOk(state, 'OFFER_TRADE', { payload: { recipientId: 'Grace', offer: smelteryOffer() } });

    const parsed = parseSnapshot(serializeSnapshot(buildSnapshot(s1)));
    assert.ok(parsed.ok);
    if (!parsed.ok) throw new Error('unreachable');
    assert.deepEqual(parsed.snapshot.state, s1, 'byte-equal restore of the pending offer');
    assert.equal(parsed.snapshot.state.trade?.tradeId, 'trade-11');
  });

  it('a pending counter (anchorTurn null) round-trips too', () => {
    const state = craftedState({ trade: pendingSmelteryTrade({ anchorTurn: null }) });
    const parsed = parseSnapshot(serializeSnapshot(buildSnapshot(state)));
    assert.ok(parsed.ok);
    if (!parsed.ok) throw new Error('unreachable');
    assert.deepEqual(parsed.snapshot.state, state);
  });

  it('a malformed pending trade is refused, never silently loaded', () => {
    const badAnchor = craftedState({ trade: pendingSmelteryTrade({ anchorTurn: 'soon' as unknown as number }) });
    assert.ok(!parseSnapshot(serializeSnapshot(buildSnapshot(badAnchor))).ok, 'a non-numeric anchor is structural corruption');

    const badProposer = craftedState({ trade: pendingSmelteryTrade({ proposerId: 'mallory' }) });
    assert.ok(!parseSnapshot(serializeSnapshot(buildSnapshot(badProposer))).ok, 'an unknown proposer is structural corruption');
  });
});

// ---------------------------------------------------------------------------
// Replay, idempotency, purity (spec §3, §2.1)

describe('replay and idempotency for the trade surface (spec §3)', () => {
  it('a trade session refolds from its commands into an identical state hash', () => {
    const initial = craftedState({ owners: { [SMELTERY]: 'Grace' } });
    const offerCommand = makeCommand(initial, 'OFFER_TRADE', { payload: { recipientId: 'Grace', offer: smelteryOffer() } });
    const offered = applyCommand(initial, offerCommand, rngForState(initial.rngState));
    assert.ok(offered.ok);
    if (!offered.ok) throw new Error('unreachable');
    const answerCommand = makeCommand(offered.state, 'ANSWER_TRADE', { actor: 'Grace', payload: { tradeId: 'trade-11', response: 'ACCEPT' } });
    const live = applyCommand(offered.state, answerCommand, rngForState(offered.state.rngState));
    assert.ok(live.ok);
    if (!live.ok) throw new Error('unreachable');

    const replayed = replayCommands(initial, [offerCommand, answerCommand]);
    assert.equal(stateHash(replayed.state), stateHash(live.state), 'the replayed state is bit-identical');
    const liveStream = [...offered.events, ...live.events];
    assert.deepEqual(eventTypes(replayed.events), eventTypes(liveStream), 'the replayed event stream matches the live fold');
  });

  it('a duplicate commandId applies the offer exactly once', () => {
    const state = craftedState({ owners: { [SMELTERY]: 'Grace' } });
    const command = makeCommand(state, 'OFFER_TRADE', { commandId: 'cmd-trade-once', payload: { recipientId: 'Grace', offer: smelteryOffer() } });
    const first = applyCommand(state, command, rngForState(state.rngState));
    assert.ok(first.ok);
    if (!first.ok) throw new Error('unreachable');

    // Resubmit against the POST-first state — the command id is already
    // processed there, so the retry must apply nothing.
    const retry = applyCommand(first.state, command, rngForState(first.state.rngState));
    assert.ok(retry.ok);
    if (!retry.ok) throw new Error('unreachable');
    assert.equal(retry.applied, false, 'the retry applies nothing');
    assert.deepEqual(retry.events, []);
    assert.equal(stateHash(retry.state), stateHash(first.state));
  });

  it('a stale expectedVersion rejects the answer with VERSION_CONFLICT', () => {
    const state = craftedState({ owners: { [SMELTERY]: 'Grace' }, trade: pendingSmelteryTrade() });
    assert.equal(applyErrCode(state, 'ANSWER_TRADE', { actor: 'Grace', expectedVersion: state.version + 1, payload: { tradeId: 'trade-11', response: 'ACCEPT' } }), 'VERSION_CONFLICT');
  });

  it('rejections leave the state byte-identical — trade commands never half-apply', () => {
    // Both cases answer one pending offer whose give leg ($2,000) exceeds
    // the proposer's cash: the COUNTER is a shape fault, the ACCEPT fails
    // cash-capacity revalidation. Neither may move anything.
    const state = craftedState({
      owners: { [SMELTERY]: 'Grace' },
      trade: pendingSmelteryTrade({ offer: { give: { cash: 2000, spaceIds: [] }, receive: { cash: 0, spaceIds: [SMELTERY] } } }),
    });
    const before = structuredClone(state);
    const rejections: Array<[CommandType, Record<string, unknown>]> = [
      ['ANSWER_TRADE', { tradeId: 'trade-11', response: 'COUNTER' }], // missing counterOffer
      ['ANSWER_TRADE', { tradeId: 'trade-11', response: 'ACCEPT' }], // give leg over the proposer's cash
    ];
    for (const [type, payload] of rejections) {
      const result = applyCommand(state, makeCommand(state, type, { actor: 'Grace', payload }), rngForState(state.rngState));
      assert.ok(!result.ok, `${type} must be rejected`);
      assert.deepEqual(state, before, `a rejected ${type} changed nothing`);
    }
  });
});

// ---------------------------------------------------------------------------
// §17.2 — the trade surface cannot bankrupt anyone

describe('§17.2 — the trade surface’s structural ban', () => {
  it('type level: the trade event vocabulary has no bankruptcy members', () => {
    type Banned = Extract<TradeEventInput, { type: 'PLAYER_BANKRUPT' | 'PLAYER_ELIMINATED' | 'ASSETS_TRANSFERRED' }>;
    const probe: readonly Banned[] = [];
    assert.equal(probe.length, 0, 'the Extract type resolves to never — compile-time ban');
  });

  it('runtime: a driven lifecycle of offers, counters, rejections, and acceptances emits no bankruptcy events', () => {
    const start = craftedState({ owners: { [SMELTERY]: 'Grace' } });
    const collected: AnyGameEvent[] = [];

    const offer = applyOk(start, 'OFFER_TRADE', { payload: { recipientId: 'Grace', offer: smelteryOffer() } });
    collected.push(...offer.events);
    const counter: TradeOffer = { give: { cash: 0, spaceIds: [SMELTERY] }, receive: { cash: 100, spaceIds: [] } };
    const counterAnswer = applyOk(offer.state, 'ANSWER_TRADE', { actor: 'Grace', payload: { tradeId: 'trade-11', response: 'COUNTER', counterOffer: counter } });
    collected.push(...counterAnswer.events);
    const reject = applyOk(counterAnswer.state, 'ANSWER_TRADE', { actor: 'Ada', payload: { tradeId: 'trade-13', response: 'REJECT' } });
    collected.push(...reject.events);
    const reoffer = applyOk(reject.state, 'OFFER_TRADE', { payload: { recipientId: 'Grace', offer: { give: { cash: 0, spaceIds: [] }, receive: { cash: 0, spaceIds: [SMELTERY] } } } });
    collected.push(...reoffer.events);
    const accept = applyOk(reoffer.state, 'ANSWER_TRADE', { actor: 'Grace', payload: { tradeId: 'trade-15', response: 'ACCEPT' } });
    collected.push(...accept.events);

    for (const event of collected) {
      assert.ok(
        event.type !== 'PLAYER_BANKRUPT' && event.type !== 'ASSETS_TRANSFERRED' && event.type !== 'PLAYER_ELIMINATED',
        `trade path emitted banned event ${event.type}`,
      );
    }
  });

  // Seam note (spec §17.2, PR 8): offers involving a player who is
  // eliminated or bankrupt are CANCELLED by the bankruptcy waterfall. This
  // build cannot eliminate anyone, so cancellation-on-elimination is
  // deliberately unimplemented and untested here — PR 8 owns both the
  // behavior and its tests.
});
