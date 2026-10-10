import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CommandType, GameCommand } from '../../src/lib/game/commands';
import { BOARD_SPACES, isPurchasable } from '../../src/lib/game/board-v1';
import { nearestParkIndex } from '../../src/lib/game/engine/movement';
import { applyCommand, createGame } from '../../src/lib/game/engine/reducer';
import { LocalCommandSink } from '../../src/lib/game/engine/transport';
import { RuleError } from '../../src/lib/game/engine/errors';
import { rngForState } from '../../src/lib/game/rng';
import type { AnyGameEvent } from '../../src/lib/game/events';
import { RULES_VERSION, type GameState, type PlayerId, type PlayerState } from '../../src/lib/game/types';

// ---------------------------------------------------------------------------
// Helpers

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

/** Seed whose first roll is doubles. */
const DOUBLES_SEED = findSeed(500, (seed) => firstRoll(seed)[0] === firstRoll(seed)[1]);

/** Seed whose first three roll pairs are all doubles (2-player: the roller takes three consecutive rolls via extra cycles). */
const TRIPLE_DOUBLES_SEED = findSeed(10000, (seed) => {
  const rng = rngForState(seed);
  const draw = () => rng.nextInt(6) + 1;
  const a = draw(), b = draw(), c = draw(), d = draw(), e = draw(), f = draw();
  return a === b && c === d && e === f;
});

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

function applyOk(
  state: GameState,
  type: CommandType,
  opts: { actor?: PlayerId; payload?: Record<string, unknown> } = {},
): { state: GameState; events: readonly AnyGameEvent[] } {
  const result = applyCommand(state, makeCommand(state, type, opts), rngForState(state.rngState));
  assert.ok(result.ok, `${type} must apply: ${result.ok ? '' : result.error.message}`);
  if (!result.ok) throw new Error('unreachable');
  return result;
}

function applyErr(
  state: GameState,
  type: CommandType,
  opts: { actor?: PlayerId; payload?: Record<string, unknown> } = {},
): RuleError {
  const result = applyCommand(state, makeCommand(state, type, opts), rngForState(state.rngState));
  assert.ok(!result.ok, `${type} must be rejected`);
  if (result.ok) throw new Error('unreachable');
  return result.error;
}

/** Create + START_GAME with the given seed (2 players unless told otherwise). */
function startedGame(seed: number, playerIds: readonly string[] = ['Ada', 'Grace']): GameState {
  const created = createGame({ gameId: 'g-slice', seed, playerIds });
  assert.ok(created.ok);
  if (!created.ok) throw new Error('unreachable');
  const started = applyOk(created.state, 'START_GAME', { actor: 'Ada' });
  return started.state;
}

/** A fully-populated player for hand-built mid-game states. */
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

/** Hand-build a PLAYING state — the only way to reach mid-game fixtures the
 *  slice's command surface cannot produce yet (Hold tokens, deep positions). */
function craftedState(overrides: {
  players?: PlayerState[];
  activePlayerId?: PlayerId | null;
  turn?: number;
  doublesCount?: number;
  turnPhase?: GameState['turnPhase'];
  rngState?: number;
  owners?: Record<string, PlayerId>;
  upgrades?: Record<string, number>;
  mortgaged?: Record<string, boolean>;
  eventDeck?: { drawPile: string[]; discardPile: string[] };
  debt?: GameState['debt'];
} = {}): GameState {
  return {
    gameId: 'g-craft',
    version: 7,
    phase: 'PLAYING',
    turnPhase: overrides.turnPhase ?? 'AWAITING_ROLL',
    mode: 'CLASSIC',
    doublesCount: overrides.doublesCount ?? 0,
    owners: overrides.owners ?? {},
    upgrades: overrides.upgrades ?? {},
    mortgaged: overrides.mortgaged ?? {},
    eventDeck: overrides.eventDeck ?? { drawPile: [], discardPile: [] },
    debt: overrides.debt ?? null,
    auction: null,
    trade: null,
    estateSale: null,
    rulesVersion: RULES_VERSION,
    seed: 1,
    rngState: overrides.rngState ?? 1,
    players: overrides.players ?? [mkPlayer({ id: 'Ada', seat: 0 }), mkPlayer({ id: 'Grace', seat: 1 })],
    activePlayerId: overrides.activePlayerId !== undefined ? overrides.activePlayerId : 'Ada',
    turn: overrides.turn ?? 3,
    round: 1,
    lastEventSequence: 40,
    processedCommandIds: [],
  };
}

function eventTypes(events: readonly AnyGameEvent[]): string[] {
  return events.map((e) => e.type);
}

/** Resolve a BUY_DECISION the way the slice UI does: buy at list price when
 *  affordable, else decline (transitional PASS_TO_AUCTION). A no-op outside
 *  BUY_DECISION — chains can call it unconditionally after every ROLL. */
function resolveBuyDecision(state: GameState): GameState {
  if (state.turnPhase !== 'BUY_DECISION') return state;
  const player = state.players.find((p) => p.id === state.activePlayerId);
  assert.ok(player);
  const landed = BOARD_SPACES[player.position];
  if (isPurchasable(landed) && player.cash >= landed.listPrice) {
    return applyOk(state, 'BUY', { payload: { spaceId: landed.id } }).state;
  }
  return applyOk(state, 'PASS_TO_AUCTION').state;
}

// ---------------------------------------------------------------------------
// Row 1 — ROLL

describe('row 1 — ROLL', () => {
  it('rolls two dice, moves the token, and settles into BUY_DECISION or TURN_MANAGEMENT', () => {
    const seed = 1;
    const [die1, die2] = firstRoll(seed);
    const state = startedGame(seed);
    const { state: s1, events } = applyOk(state, 'ROLL');

    assert.deepEqual(eventTypes(events).slice(0, 2), ['DICE_ROLLED', 'PLAYER_MOVED']);
    const rolled = events[0];
    assert.ok(rolled.type === 'DICE_ROLLED' && rolled.meta.dice);
    assert.deepEqual(rolled.meta.dice, [die1, die2]);

    const moved = events[1];
    assert.ok(moved.type === 'PLAYER_MOVED');
    assert.equal(moved.payload.to, (die1 + die2) % 32);

    const landed = BOARD_SPACES[moved.payload.to];
    const expectedPhase = isPurchasable(landed) ? 'BUY_DECISION' : 'TURN_MANAGEMENT';
    assert.equal(s1.turnPhase, expectedPhase);
    assert.equal(s1.version, state.version + 1);
    assert.equal(s1.players[0].position, moved.payload.to);
    assert.equal(s1.doublesCount, die1 === die2 ? 1 : 0);
  });

  it('rejects ROLL outside AWAITING_ROLL', () => {
    const state = startedGame(1);
    const { state: s1 } = applyOk(state, 'ROLL');
    assert.equal(applyErr(s1, 'ROLL').code, 'INVALID_PHASE');
  });

  it('rejects ROLL by a non-active player', () => {
    const state = startedGame(1);
    assert.equal(applyErr(state, 'ROLL', { actor: 'Grace' }).code, 'NOT_AUTHORIZED');
  });
});

// ---------------------------------------------------------------------------
// Doubles — rows 1, 4, 12

describe('doubles semantics', () => {
  it('a doubles roll grants exactly one extra cycle: same player, same turn ordinal', () => {
    const state = startedGame(DOUBLES_SEED);
    const roller = state.activePlayerId;
    const { state: s1 } = applyOk(state, 'ROLL');
    assert.equal(s1.doublesCount, 1);
    const { state: s2, events } = applyOk(resolveBuyDecision(s1), 'END_TURN');

    assert.equal(s2.activePlayerId, roller, 'doubles must not pass the turn');
    assert.equal(s2.turn, s1.turn, 'the extra cycle shares the turn ordinal');
    assert.equal(s2.turnPhase, 'AWAITING_ROLL');
    assert.ok(eventTypes(events).includes('TURN_STARTED'));
    const started = events.find((e) => e.type === 'TURN_STARTED');
    assert.ok(started && started.type === 'TURN_STARTED' && started.payload.playerId === roller);
  });

  it('a non-doubles roll resets the counter and passes the turn', () => {
    // DOUBLES_SEED rolls doubles first, then a non-doubles pair.
    const state = startedGame(DOUBLES_SEED);
    const s1 = resolveBuyDecision(applyOk(state, 'ROLL').state);
    const s2 = applyOk(s1, 'END_TURN').state;
    const s3 = resolveBuyDecision(applyOk(s2, 'ROLL').state);
    assert.equal(s3.doublesCount, 0, 'a non-doubles roll resets the counter');
    const { state: s4, events } = applyOk(s3, 'END_TURN');

    assert.notEqual(s4.activePlayerId, s3.activePlayerId);
    assert.equal(s4.turn, s3.turn + 1, 'a real handover consumes one turn ordinal');
    const started = events.find((e) => e.type === 'TURN_STARTED');
    assert.ok(started && started.type === 'TURN_STARTED');
    assert.notEqual(started.payload.playerId, s3.activePlayerId);
  });

  it('the third consecutive doubles skips dice movement and relocates to the nearest park', () => {
    const state = startedGame(TRIPLE_DOUBLES_SEED);
    const roller = state.activePlayerId;
    const s1 = resolveBuyDecision(applyOk(state, 'ROLL').state);
    const s2 = applyOk(s1, 'END_TURN').state;
    const s3 = resolveBuyDecision(applyOk(s2, 'ROLL').state);
    const s4 = applyOk(s3, 'END_TURN').state;
    const before = s4.players.find((p) => p.id === roller)?.position ?? -1;

    const { state: s5, events } = applyOk(s4, 'ROLL');

    const moved = events.find((e) => e.type === 'PLAYER_MOVED');
    assert.ok(moved && moved.type === 'PLAYER_MOVED');
    const expectedPark = nearestParkIndex(before, BOARD_SPACES);
    assert.equal(moved.payload.to, expectedPark, 'the token goes to the nearest park');
    assert.notEqual(moved.payload.to, before % 32, 'the third roll must not move by its dice');

    assert.equal(eventTypes(events).includes('START_BONUS_PAID'), false);
    const rollerState = s5.players.find((p) => p.id === roller);
    assert.ok(rollerState);
    assert.equal(rollerState.skipNextTurn, true, 'the next turn is marked for skipping');
    assert.equal(s5.doublesCount, 0, 'the penalty resets the counter');
    assert.notEqual(s5.activePlayerId, roller, 'the turn ends without a management phase');
    assert.equal(s5.turnPhase, 'AWAITING_ROLL');
  });

  it('the marked skip is consumed as TURN_SKIPPED + TURN_ENDED at the next handover', () => {
    const state = startedGame(TRIPLE_DOUBLES_SEED);
    const roller = state.activePlayerId;
    const other = state.players.find((p) => p.id !== roller)?.id as PlayerId;
    let s = applyOk(state, 'ROLL').state;
    s = resolveBuyDecision(s);
    s = applyOk(s, 'END_TURN').state;
    s = applyOk(s, 'ROLL').state;
    s = resolveBuyDecision(s);
    s = applyOk(s, 'END_TURN').state;
    s = applyOk(s, 'ROLL').state; // third doubles — roller marked, no decision follows

    s = resolveBuyDecision(applyOk(s, 'ROLL', { actor: other }).state); // other player's turn
    const { state: after, events } = applyOk(s, 'END_TURN', { actor: other });

    const skipped = events.find((e) => e.type === 'TURN_SKIPPED');
    assert.ok(skipped && skipped.type === 'TURN_SKIPPED');
    assert.equal(skipped.payload.playerId, roller);
    assert.equal(skipped.payload.reason, 'THIRD_DOUBLES');

    const started = events.find((e) => e.type === 'TURN_STARTED');
    assert.ok(started && started.type === 'TURN_STARTED');
    assert.equal(started.payload.playerId, other, 'the wheel moves past the marked player');

    const rollerState = after.players.find((p) => p.id === roller);
    assert.ok(rollerState);
    assert.equal(rollerState.skipNextTurn, false, 'the mark is consumed, not hoarded');
    assert.equal(after.activePlayerId, other);
  });
});

// ---------------------------------------------------------------------------
// Row 2 — HOLD

describe('row 2 — HOLD', () => {
  it('rejects HOLD without a Hold token', () => {
    const state = startedGame(1);
    const error = applyErr(state, 'HOLD');
    assert.equal(error.code, 'INSUFFICIENT_RESOURCES');
  });

  it('consumes the token, skips the whole turn, and hands over', () => {
    const state = craftedState({
      players: [mkPlayer({ id: 'Ada', seat: 0, tokens: { HOLD: 1, RENT_HOLIDAY: 0 } }), mkPlayer({ id: 'Grace', seat: 1 })],
      turn: 4,
    });
    const { state: s1, events } = applyOk(state, 'HOLD');

    assert.deepEqual(eventTypes(events), ['TOKEN_CONSUMED', 'TURN_SKIPPED', 'TURN_ENDED', 'TURN_STARTED']);
    const consumed = events[0];
    assert.ok(consumed.type === 'TOKEN_CONSUMED' && consumed.payload.token === 'HOLD');
    const skipped = events[1];
    assert.ok(skipped.type === 'TURN_SKIPPED' && skipped.payload.reason === 'HOLD_TOKEN');

    const ada = s1.players.find((p) => p.id === 'Ada');
    assert.ok(ada);
    assert.equal(ada.tokens.HOLD, 0);
    assert.equal(s1.activePlayerId, 'Grace');
    assert.equal(s1.turn, 5, 'the skipped handover consumes one turn ordinal');
    assert.equal(s1.turnPhase, 'AWAITING_ROLL');
    assert.equal(s1.doublesCount, 0);
  });

  it('is rejected outside AWAITING_ROLL', () => {
    const state = craftedState({ turnPhase: 'TURN_MANAGEMENT' });
    assert.equal(applyErr(state, 'HOLD').code, 'INVALID_PHASE');
  });
});

// ---------------------------------------------------------------------------
// Row 3 — start bonus

describe('row 3 — start bonus on passing Gateway Terminal', () => {
  it('pays $250 when the move crosses Gateway Terminal', () => {
    // From position 28 a roll of 4 crosses 0 and rests on Gateway Terminal —
    // a landing with no charge, so the bonus is the only cash movement.
    const seed = findSeed(500, (s) => {
      const [a, b] = firstRoll(s);
      return a + b === 4;
    });
    const [die1, die2] = firstRoll(seed);
    const state = craftedState({ players: [mkPlayer({ id: 'Ada', seat: 0, position: 28 }), mkPlayer({ id: 'Grace', seat: 1 })], rngState: seed });

    const { state: s1, events } = applyOk(state, 'ROLL');

    const ada = s1.players.find((p) => p.id === 'Ada');
    assert.ok(ada);
    assert.equal(ada.position, (28 + die1 + die2) % 32);
    assert.equal(ada.cash, 1500 + 250);
    const bonus = events.find((e) => e.type === 'START_BONUS_PAID');
    assert.ok(bonus && bonus.type === 'START_BONUS_PAID');
    assert.equal(bonus.payload.amount, 250);
    assert.equal(bonus.payload.playerId, 'Ada');
  });

  it('pays nothing on a mid-board move', () => {
    // A roll of 3 from position 5 rests on Founders Green (a park, index 8)
    // — no landing charge, so cash is untouched.
    const seed = findSeed(500, (s) => {
      const [a, b] = firstRoll(s);
      return a + b === 3;
    });
    const state = craftedState({ players: [mkPlayer({ id: 'Ada', seat: 0, position: 5 }), mkPlayer({ id: 'Grace', seat: 1 })], rngState: seed });
    const { state: s1, events } = applyOk(state, 'ROLL');
    assert.equal(eventTypes(events).includes('START_BONUS_PAID'), false);
    const ada = s1.players.find((p) => p.id === 'Ada');
    assert.ok(ada);
    assert.equal(ada.cash, 1500);
  });

  it('placement at game start is not a landing — no bonus, no events', () => {
    const created = createGame({ gameId: 'g-slice', seed: 1, playerIds: ['Ada', 'Grace'] });
    assert.ok(created.ok);
    if (!created.ok) throw new Error('unreachable');
    const { events } = applyOk(created.state, 'START_GAME', { actor: 'Ada' });
    assert.equal(eventTypes(events).includes('START_BONUS_PAID'), false);
    assert.equal(eventTypes(events).includes('PLAYER_MOVED'), false);
    for (const p of created.state.players) {
      assert.equal(p.position, 0);
      assert.equal(p.cash, 1500);
    }
  });
});

// ---------------------------------------------------------------------------
// Row 5 — BUY

describe('row 5 — BUY', () => {
  it('buys the token-space at list price and moves to TURN_MANAGEMENT', () => {
    const state = craftedState({
      players: [mkPlayer({ id: 'Ada', seat: 0, position: 1, cash: 1500 }), mkPlayer({ id: 'Grace', seat: 1 })],
      turnPhase: 'BUY_DECISION',
    });
    const space = BOARD_SPACES[1];
    assert.ok(isPurchasable(space));

    const { state: s1, events } = applyOk(state, 'BUY', { payload: { spaceId: space.id } });

    assert.equal(s1.owners[space.id], 'Ada');
    const ada = s1.players.find((p) => p.id === 'Ada');
    assert.ok(ada);
    assert.equal(ada.cash, 1500 - space.listPrice);
    assert.equal(s1.turnPhase, 'TURN_MANAGEMENT');
    assert.deepEqual(eventTypes(events), ['PROPERTY_PURCHASED']);
    const purchased = events[0];
    assert.ok(purchased.type === 'PROPERTY_PURCHASED');
    assert.equal(purchased.payload.via, 'DIRECT');
    assert.equal(purchased.payload.amount, space.listPrice);
  });

  it('accepts BUY without a payload spaceId (the token space is implied)', () => {
    const state = craftedState({
      players: [mkPlayer({ id: 'Ada', seat: 0, position: 1 }), mkPlayer({ id: 'Grace', seat: 1 })],
      turnPhase: 'BUY_DECISION',
    });
    const { state: s1 } = applyOk(state, 'BUY');
    assert.equal(s1.owners[BOARD_SPACES[1].id], 'Ada');
  });

  it('rejects BUY with a payload spaceId that does not match the token space', () => {
    const state = craftedState({
      players: [mkPlayer({ id: 'Ada', seat: 0, position: 1 }), mkPlayer({ id: 'Grace', seat: 1 })],
      turnPhase: 'BUY_DECISION',
    });
    assert.equal(applyErr(state, 'BUY', { payload: { spaceId: 'somewhere-else' } }).code, 'RULE_VIOLATION');
  });

  it('rejects BUY without enough cash', () => {
    const state = craftedState({
      players: [mkPlayer({ id: 'Ada', seat: 0, position: 1, cash: 10 }), mkPlayer({ id: 'Grace', seat: 1 })],
      turnPhase: 'BUY_DECISION',
    });
    const error = applyErr(state, 'BUY');
    assert.equal(error.code, 'INSUFFICIENT_RESOURCES');
    assert.deepEqual(state.owners, {}, 'a rejected BUY must not transfer ownership');
  });

  it('rejects BUY on a non-purchasable space', () => {
    const park = BOARD_SPACES.findIndex((s) => s.kind === 'PARK');
    const state = craftedState({
      players: [mkPlayer({ id: 'Ada', seat: 0, position: park }), mkPlayer({ id: 'Grace', seat: 1 })],
      turnPhase: 'BUY_DECISION',
    });
    assert.equal(applyErr(state, 'BUY').code, 'RULE_VIOLATION');
  });

  it('rejects BUY on an already-owned space', () => {
    const state = craftedState({
      players: [mkPlayer({ id: 'Ada', seat: 0, position: 1 }), mkPlayer({ id: 'Grace', seat: 1 })],
      turnPhase: 'BUY_DECISION',
      owners: { 'foundry-smeltery': 'Grace' },
    });
    assert.equal(applyErr(state, 'BUY').code, 'RULE_VIOLATION');
  });

  it('rejects BUY outside BUY_DECISION', () => {
    const state = craftedState({ turnPhase: 'TURN_MANAGEMENT' });
    assert.equal(applyErr(state, 'BUY').code, 'INVALID_PHASE');
  });
});

// ---------------------------------------------------------------------------
// Row 6 — PASS_TO_AUCTION (spec §5, implemented in PR 6)

describe('row 6 — PASS_TO_AUCTION opens a real auction (spec §5, PR 6)', () => {
  it('opens the auction: phase AUCTION, decliner eligible, no money moved', () => {
    const state = craftedState({
      players: [mkPlayer({ id: 'Ada', seat: 0, position: 1 }), mkPlayer({ id: 'Grace', seat: 1 })],
      turnPhase: 'BUY_DECISION',
    });
    const { state: s1, events } = applyOk(state, 'PASS_TO_AUCTION');

    assert.deepEqual(eventTypes(events), ['AUCTION_OPENED']);
    assert.equal(s1.turnPhase, 'AUCTION');
    assert.equal(s1.activePlayerId, 'Ada', "the auction runs inside the decliner's turn");
    assert.deepEqual(s1.owners, {}, 'the space stays with the bank until a bid settles');
    assert.deepEqual(s1.players.map((p) => p.cash), [1500, 1500], 'declining moves no money');
    const auction = s1.auction;
    assert.ok(auction);
    assert.equal(auction.spaceId, 'foundry-smeltery', 'the token-space sells, not a payload choice');
    assert.equal(auction.reason, 'DECLINED');
    assert.equal(auction.currentBid, null);
    assert.equal(auction.highBidderId, null);
    assert.deepEqual(auction.passedPlayerIds, []);
    assert.deepEqual(auction.eligiblePlayerIds, ['Ada', 'Grace'], 'the decliner may bid (Decision D-2)');
    assert.equal(auction.auctionId, 'auction-41', 'id derives from the opening event sequence');
  });

  it('is rejected outside BUY_DECISION', () => {
    const state = craftedState({ turnPhase: 'AWAITING_ROLL' });
    assert.equal(applyErr(state, 'PASS_TO_AUCTION').code, 'INVALID_PHASE');
  });

  it('rejects a second decline once the auction is open', () => {
    const state = craftedState({
      players: [mkPlayer({ id: 'Ada', seat: 0, position: 1 }), mkPlayer({ id: 'Grace', seat: 1 })],
      turnPhase: 'BUY_DECISION',
    });
    const { state: s1 } = applyOk(state, 'PASS_TO_AUCTION');
    assert.equal(applyErr(s1, 'PASS_TO_AUCTION').code, 'INVALID_PHASE');
  });
});

// ---------------------------------------------------------------------------
// Row 12 — END_TURN

describe('row 12 — END_TURN', () => {
  it('passes the turn to the next player and bumps the turn ordinal', () => {
    const state = craftedState({ turnPhase: 'TURN_MANAGEMENT', doublesCount: 0, turn: 3 });
    const { state: s1, events } = applyOk(state, 'END_TURN');

    assert.deepEqual(eventTypes(events), ['TURN_ENDED', 'TURN_STARTED']);
    assert.equal(s1.activePlayerId, 'Grace');
    assert.equal(s1.turn, 4);
    assert.equal(s1.turnPhase, 'AWAITING_ROLL');
    assert.equal(s1.doublesCount, 0, 'the counter resets when the turn passes');
  });

  it('wraps from the last seat back to the first', () => {
    const state = craftedState({
      players: [mkPlayer({ id: 'Ada', seat: 0 }), mkPlayer({ id: 'Grace', seat: 1 })],
      activePlayerId: 'Grace',
      turnPhase: 'TURN_MANAGEMENT',
      turn: 6,
    });
    const { state: s1 } = applyOk(state, 'END_TURN', { actor: 'Grace' });
    assert.equal(s1.activePlayerId, 'Ada');
    assert.equal(s1.turn, 7);
  });

  it('is rejected outside TURN_MANAGEMENT', () => {
    const state = craftedState({ turnPhase: 'AWAITING_ROLL' });
    assert.equal(applyErr(state, 'END_TURN').code, 'INVALID_PHASE');
  });

  it('a duplicate commandId applies exactly once (idempotency through the slice)', () => {
    const state = craftedState({ turnPhase: 'TURN_MANAGEMENT' });
    const command = makeCommand(state, 'END_TURN', { commandId: 'same-id' });
    const first = applyCommand(state, command, rngForState(state.rngState));
    assert.ok(first.ok);
    // Resubmission targets the advanced state — the ledger there contains the id.
    if (!first.ok) throw new Error('unreachable');
    const second = applyCommand(first.state, command, rngForState(first.state.rngState));
    assert.ok(second.ok);
    assert.equal(second.applied, false, 'the duplicate must not apply again');
    // The raw reducer's state keeps only ledger IDS (§2.4) — stored events
    // are the sink's seam, covered by the sink test below.
    assert.deepEqual(second.events, []);
    assert.deepEqual(second.state, first.state);
  });

  it('a duplicate submit through the LocalCommandSink returns the stored events (§2.1 step 4)', async () => {
    const sink = LocalCommandSink.create({ gameId: 'g-idem', seed: 5, playerIds: ['Ada', 'Grace'] });
    const start = {
      commandId: 'start-1',
      gameId: 'g-idem',
      actorId: 'Ada',
      expectedVersion: 0,
      type: 'START_GAME',
      payload: {},
    } as GameCommand;
    const first = await sink.submit(start);
    assert.ok(first.ok && first.applied);
    const retry = await sink.submit(start);
    assert.ok(retry.ok);
    assert.equal(retry.applied, false);
    assert.deepEqual(retry.events, first.ok ? first.events : [], 'the sink replays the original stored events');
    assert.deepEqual(retry.state, sink.state());
  });
});
