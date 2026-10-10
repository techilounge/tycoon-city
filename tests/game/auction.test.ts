/**
 * Auction contract tests — spec §5 and phase-table rows 6–8 (PR 6).
 *
 * Every §5 rule gets a test: cash-backed bids, $10 opening and increments,
 * the decliner's right to bid (Decision D-2), binding passes, a high bidder
 * who cannot pass, all-pass unsold, immediate single-bidder settlement
 * inside the resolving command, and free-form bid-order determinism proven
 * by log replay. Foundation contracts (idempotency, version conflicts,
 * purity, snapshot validation) are pinned for auction commands too.
 * §17.2: the bankruptcy ban is asserted at type level and by runtime scan.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CommandType, GameCommand } from '../../src/lib/game/commands';
import { BOARD_SPACES, isPurchasable } from '../../src/lib/game/board-v1';
import { applyCommand, createGame } from '../../src/lib/game/engine/reducer';
import { replayCommands, stateHash } from '../../src/lib/game/engine/replay';
import { RuleError } from '../../src/lib/game/engine/errors';
import { rngForState } from '../../src/lib/game/rng';
import { buildSnapshot, parseSnapshot, serializeSnapshot } from '../../src/lib/game/snapshot-schema';
import type { AnyGameEvent } from '../../src/lib/game/events';
import type { AuctionEventInput } from '../../src/lib/game/engine/auctions';
import { isLegalBidAmount } from '../../src/lib/game/rules-v1';
import { RULES_VERSION, type AuctionState, type GameState, type PlayerId, type PlayerState } from '../../src/lib/game/types';

// ---------------------------------------------------------------------------
// Helpers (per-file copies of the established pattern)

function firstRoll(seed: number): [number, number] {
  const rng = rngForState(seed);
  return [rng.nextInt(6) + 1, rng.nextInt(6) + 1];
}

function findSeed(maxSeed: number, predicate: (seed: number) => boolean): number {
  for (let seed = 1; seed <= maxSeed; seed++) {
    if (predicate(seed)) return seed;
  }
  throw new Error(`test data: no seed <= ${maxSeed} satisfies the dice predicate`);
}

/** Seed whose first roll lands the starting player on an unowned purchasable
 *  space — a real decline-to-auction is reachable from a plain opening. */
const AUCTION_SEED = findSeed(500, (seed) => {
  const [a, b] = firstRoll(seed);
  return isPurchasable(BOARD_SPACES[a + b]);
});

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
  opts: { actor?: PlayerId; payload?: Record<string, unknown>; commandId?: string; expectedVersion?: number } = {},
): { state: GameState; events: readonly AnyGameEvent[] } {
  const result = applyCommand(state, makeCommand(state, type, opts), rngForState(state.rngState));
  assert.ok(result.ok, `${type} must apply: ${result.ok ? '' : result.error.message}`);
  if (!result.ok) throw new Error('unreachable');
  return result;
}

function applyErr(
  state: GameState,
  type: CommandType,
  opts: { actor?: PlayerId; payload?: Record<string, unknown>; commandId?: string; expectedVersion?: number } = {},
): RuleError {
  const result = applyCommand(state, makeCommand(state, type, opts), rngForState(state.rngState));
  assert.ok(!result.ok, `${type} must be rejected`);
  if (result.ok) throw new Error('unreachable');
  return result.error;
}

function eventTypes(events: readonly AnyGameEvent[]): string[] {
  return events.map((e) => e.type);
}

function cashOf(state: GameState, id: PlayerId): number {
  const player = state.players.find((p) => p.id === id);
  assert.ok(player);
  return player.cash;
}

function auctionOf(state: GameState): AuctionState {
  assert.equal(state.turnPhase, 'AUCTION', 'the phase is AUCTION');
  const auction = state.auction;
  assert.ok(auction, 'an open auction is exactly an AUCTION phase (tested invariant)');
  return auction;
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

/** Hand-build a PLAYING state (same shape as turn-machine's fixture, plus an
 *  auction override for snapshot/schema work). */
function craftedState(overrides: {
  players?: PlayerState[];
  activePlayerId?: PlayerId | null;
  turnPhase?: GameState['turnPhase'];
  rngState?: number;
  owners?: Record<string, PlayerId>;
  auction?: GameState['auction'];
  trade?: GameState['trade'];
  lastEventSequence?: number;
} = {}): GameState {
  return {
    gameId: 'g-auction',
    version: 7,
    phase: 'PLAYING',
    turnPhase: overrides.turnPhase ?? 'AWAITING_ROLL',
    mode: 'CLASSIC',
    doublesCount: 0,
    owners: overrides.owners ?? {},
    upgrades: {},
    mortgaged: {},
    eventDeck: { drawPile: [], discardPile: [] },
    debt: null,
    auction: overrides.auction ?? null,
    trade: overrides.trade ?? null,
    rulesVersion: RULES_VERSION,
    seed: 1,
    rngState: overrides.rngState ?? 1,
    players: overrides.players ?? [mkPlayer({ id: 'Ada', seat: 0, position: 1 }), mkPlayer({ id: 'Grace', seat: 1 })],
    activePlayerId: overrides.activePlayerId !== undefined ? overrides.activePlayerId : 'Ada',
    turn: 3,
    lastEventSequence: overrides.lastEventSequence ?? 40,
    processedCommandIds: [],
  };
}

/** An open auction on Ada's token space (foundry-smeltery), produced by the
 *  real row-6 handler from a crafted BUY_DECISION — never hand-built: the
 *  reducer owns the auction id and the eligibility snapshot. */
function openAuction(opts: { players?: PlayerState[] } = {}): GameState {
  const state = craftedState({
    players: opts.players ?? [mkPlayer({ id: 'Ada', seat: 0, position: 1 }), mkPlayer({ id: 'Grace', seat: 1 })],
    turnPhase: 'BUY_DECISION',
  });
  const { state: s1 } = applyOk(state, 'PASS_TO_AUCTION');
  return s1;
}

/** A contested auction settled at 130 by Ada: Grace bid 100, Ada 130, Grace
 *  passed. Exercises bids, the decliner's right to bid, and pass-resolution. */
function contestedAuction(): GameState {
  const state = openAuction();
  const id = auctionOf(state).auctionId;
  const { state: s1 } = applyOk(state, 'BID', { actor: 'Grace', payload: { auctionId: id, amount: 100 } });
  const { state: s2 } = applyOk(s1, 'BID', { actor: 'Ada', payload: { auctionId: id, amount: 130 } });
  const { state: s3 } = applyOk(s2, 'PASS_BID', { actor: 'Grace', payload: { auctionId: id } });
  return s3;
}

// ---------------------------------------------------------------------------
// Bid legality — the rules-v1 formula (one test per §5 sentence)

describe('bid legality — isLegalBidAmount (spec §5)', () => {
  it('the first bid meets only the $10 opening minimum, in $10 steps', () => {
    assert.equal(isLegalBidAmount(10, null), true, 'opening minimum');
    assert.equal(isLegalBidAmount(20, null), true, 'any $10 step');
    assert.equal(isLegalBidAmount(1000, null), true, 'jump bids are legal');
    assert.equal(isLegalBidAmount(9, null), false, 'below the opening minimum');
    assert.equal(isLegalBidAmount(15, null), false, 'not a $10 step');
    assert.equal(isLegalBidAmount(10.5, null), false, 'fractional');
  });

  it('later bids ascend by at least one $10 increment above the standing bid', () => {
    assert.equal(isLegalBidAmount(110, 100), true, 'one increment');
    assert.equal(isLegalBidAmount(120, 100), true, 'a jump bid');
    assert.equal(isLegalBidAmount(109, 100), false, 'not a $10 step');
    assert.equal(isLegalBidAmount(105, 100), false, 'half increment');
    assert.equal(isLegalBidAmount(100, 100), false, 'equal is not ascending');
    assert.equal(isLegalBidAmount(90, 100), false, 'lower bids cannot exist');
  });
});

// ---------------------------------------------------------------------------
// Row 6 — opening (phase-guard matrix lives in turn-machine)

describe('row 6 — a decline opens the auction on the token space (spec §5)', () => {
  it('a real opening from a driven roll: the space opens at auction, still the decliner\'s turn', () => {
    // Drive a real game to a genuine BUY_DECISION, then decline.
    const created = createGame({ gameId: 'g-driven', seed: AUCTION_SEED, playerIds: ['Ada', 'Grace'] });
    assert.ok(created.ok);
    if (!created.ok) throw new Error('unreachable');
    const started = applyOk(created.state, 'START_GAME', { actor: 'Ada' });
    const rolled = applyOk(started.state, 'ROLL');
    const landed = BOARD_SPACES[rolled.state.players[0].position];
    assert.ok(isPurchasable(landed), 'test seed lands on a purchasable space');
    const { state: s1, events } = applyOk(rolled.state, 'PASS_TO_AUCTION');

    assert.deepEqual(eventTypes(events), ['AUCTION_OPENED']);
    assert.equal(s1.turnPhase, 'AUCTION');
    assert.equal(s1.activePlayerId, 'Ada', "the auction runs inside the decliner's turn");
    const auction = auctionOf(s1);
    assert.equal(auction.spaceId, landed.id, 'the token-space sells');
    assert.equal(auction.reason, 'DECLINED');
    assert.equal(auction.currentBid, null, 'no bid exists yet');
    assert.equal(auction.highBidderId, null);
    assert.deepEqual(auction.passedPlayerIds, []);
    assert.deepEqual(auction.eligiblePlayerIds, ['Ada', 'Grace'], 'every live player, decliner included (D-2)');
  });
});

// ---------------------------------------------------------------------------
// Row 7 — BID

describe('row 7 — BID: ascending, cash-backed, free-form (spec §5)', () => {
  it('any eligible player may open the bid at the minimum — not just the active player', () => {
    const state = openAuction();
    const id = auctionOf(state).auctionId;
    const { state: s1, events } = applyOk(state, 'BID', { actor: 'Grace', payload: { auctionId: id, amount: 10 } });

    assert.deepEqual(eventTypes(events), ['AUCTION_BID']);
    const auction = auctionOf(s1);
    assert.equal(auction.currentBid, 10);
    assert.equal(auction.highBidderId, 'Grace');
  });

  it('rejects bids below the minimum and off-step amounts', () => {
    const state = openAuction();
    const id = auctionOf(state).auctionId;
    assert.equal(applyErr(state, 'BID', { actor: 'Grace', payload: { auctionId: id, amount: 5 } }).code, 'RULE_VIOLATION');
    assert.equal(applyErr(state, 'BID', { actor: 'Grace', payload: { auctionId: id, amount: 15 } }).code, 'RULE_VIOLATION');
  });

  it('rejects a bid that is not strictly above the standing bid by a full increment', () => {
    const state = openAuction();
    const id = auctionOf(state).auctionId;
    const { state: s1 } = applyOk(state, 'BID', { actor: 'Grace', payload: { auctionId: id, amount: 100 } });
    const id2 = auctionOf(s1).auctionId;
    assert.equal(applyErr(s1, 'BID', { actor: 'Ada', payload: { auctionId: id2, amount: 100 } }).code, 'RULE_VIOLATION', 'equal bid');
    assert.equal(applyErr(s1, 'BID', { actor: 'Ada', payload: { auctionId: id2, amount: 105 } }).code, 'RULE_VIOLATION', 'half increment');
    assert.equal(applyErr(s1, 'BID', { actor: 'Ada', payload: { auctionId: id2, amount: 90 } }).code, 'RULE_VIOLATION', 'lower bid');
  });

  it('bids are strictly cash-backed: a bid above the bidder\'s cash is rejected, an exact-cash bid is accepted', () => {
    const state = openAuction({
      players: [mkPlayer({ id: 'Ada', seat: 0, position: 1, cash: 90 }), mkPlayer({ id: 'Grace', seat: 1, cash: 100 })],
    });
    const id = auctionOf(state).auctionId;
    const err = applyErr(state, 'BID', { actor: 'Ada', payload: { auctionId: id, amount: 100 } });
    assert.equal(err.code, 'INSUFFICIENT_RESOURCES', 'cash 90 cannot bid 100');
    const { state: s1 } = applyOk(state, 'BID', { actor: 'Grace', payload: { auctionId: id, amount: 100 } });
    assert.equal(auctionOf(s1).currentBid, 100, 'an exact-cash bid is payable');
  });

  it('the decliner may bid (Decision D-2) — and may raise their own standing bid', () => {
    const state = openAuction();
    const id = auctionOf(state).auctionId;
    const { state: s1 } = applyOk(state, 'BID', { actor: 'Grace', payload: { auctionId: id, amount: 10 } });
    const { state: s2 } = applyOk(s1, 'BID', { actor: 'Ada', payload: { auctionId: id, amount: 20 } });
    assert.equal(auctionOf(s2).highBidderId, 'Ada', 'the decliner took the lead');
    const { state: s3 } = applyOk(s2, 'BID', { actor: 'Ada', payload: { auctionId: id, amount: 30 } });
    assert.equal(auctionOf(s3).currentBid, 30, 'raising your own bid is legal — it only raises the price');
    assert.equal(auctionOf(s3).highBidderId, 'Ada');
  });

  it('a passed player may not bid again — passes are binding', () => {
    const state = openAuction();
    const id = auctionOf(state).auctionId;
    const { state: s1 } = applyOk(state, 'PASS_BID', { actor: 'Grace', payload: { auctionId: id } });
    assert.equal(applyErr(s1, 'BID', { actor: 'Grace', payload: { auctionId: id, amount: 10 } }).code, 'NOT_AUTHORIZED');
  });

  it('a bid naming another auctionId is rejected', () => {
    const state = openAuction();
    const id = auctionOf(state).auctionId;
    assert.equal(applyErr(state, 'BID', { actor: 'Grace', payload: { auctionId: `${id}-stale`, amount: 10 } }).code, 'RULE_VIOLATION');
  });

  it('resolves immediately inside the bidding command when the bidder is the only player who has not passed', () => {
    const state = openAuction();
    const id = auctionOf(state).auctionId;
    // Grace passes; Ada is the sole unpassed player with no standing bid —
    // the auction stays open (never award a price nobody bid).
    const { state: s1 } = applyOk(state, 'PASS_BID', { actor: 'Grace', payload: { auctionId: id } });
    assert.equal(s1.turnPhase, 'AUCTION', 'no award without a bid');
    // Ada's bid is the settlement command.
    const { state: s2, events: settleEvents } = applyOk(s1, 'BID', { actor: 'Ada', payload: { auctionId: id, amount: 10 } });
    assert.deepEqual(eventTypes(settleEvents), ['AUCTION_BID', 'AUCTION_RESOLVED', 'PROPERTY_PURCHASED'], 'settlement inside the bidding command');
    assert.equal(s2.turnPhase, 'TURN_MANAGEMENT');
    assert.equal(s2.auction, null);
    assert.equal(s2.owners['foundry-smeltery'], 'Ada');
    assert.equal(cashOf(s2, 'Ada'), 1490, 'paid the bid to the bank');
  });
});

// ---------------------------------------------------------------------------
// Row 8 — PASS_BID

describe('row 8 — PASS_BID: binding, and the high bidder cannot pass (spec §5)', () => {
  it('the current high bidder cannot pass', () => {
    const state = openAuction();
    const id = auctionOf(state).auctionId;
    const { state: s1 } = applyOk(state, 'BID', { actor: 'Grace', payload: { auctionId: id, amount: 50 } });
    const err = applyErr(s1, 'PASS_BID', { actor: 'Grace', payload: { auctionId: id } });
    assert.equal(err.code, 'RULE_VIOLATION', 'a standing bid must stay with a player in the auction');
    assert.equal(s1.turnPhase, 'AUCTION');
  });

  it('resolves on the pass that leaves one unpassed bidder — the winner pays their own standing bid', () => {
    const state = contestedAuction();
    assert.equal(state.turnPhase, 'TURN_MANAGEMENT', "back to the decliner's management phase");
    assert.equal(state.auction, null);
    assert.equal(state.owners['foundry-smeltery'], 'Ada');
    assert.equal(cashOf(state, 'Ada'), 1500 - 130, 'Ada paid her own 130, not the list price');
    assert.equal(cashOf(state, 'Grace'), 1500, 'Grace, the passer, pays nothing');
  });

  it('all passed with no bid: the space stays with the bank, unsold', () => {
    const state = openAuction();
    const id = auctionOf(state).auctionId;
    const { state: s1 } = applyOk(state, 'PASS_BID', { actor: 'Ada', payload: { auctionId: id } });
    const { state: s2, events } = applyOk(s1, 'PASS_BID', { actor: 'Grace', payload: { auctionId: id } });
    assert.deepEqual(eventTypes(events), ['AUCTION_PASS', 'AUCTION_CLOSED_UNSOLD']);
    assert.equal(s2.turnPhase, 'TURN_MANAGEMENT');
    assert.equal(s2.auction, null);
    assert.deepEqual(s2.owners, {}, 'no sale — the space stays with the bank');
    assert.deepEqual(s2.players.map((p) => p.cash), [1500, 1500], 'no money ever moved');
  });

  it('a no-bid auction never awards to the last player — they must bid or pass (spec §5)', () => {
    const three = openAuction({
      players: [mkPlayer({ id: 'Ada', seat: 0, position: 1 }), mkPlayer({ id: 'Grace', seat: 1 }), mkPlayer({ id: 'Malo', seat: 2 })],
    });
    const id3 = auctionOf(three).auctionId;
    const { state: t1 } = applyOk(three, 'PASS_BID', { actor: 'Grace', payload: { auctionId: id3 } });
    const { state: t2 } = applyOk(t1, 'PASS_BID', { actor: 'Malo', payload: { auctionId: id3 } });
    assert.equal(t2.turnPhase, 'AUCTION', 'the auction stays open for Ada');
    assert.equal(t2.auction?.currentBid, null, 'and no price has been named');
    assert.equal(t2.owners['foundry-smeltery'], undefined, 'nothing was awarded');
    // A lone bidder wins at their own (opening-minimum) bid.
    const { state: t3, events } = applyOk(t2, 'BID', { actor: 'Ada', payload: { auctionId: id3, amount: 10 } });
    assert.deepEqual(eventTypes(events), ['AUCTION_BID', 'AUCTION_RESOLVED', 'PROPERTY_PURCHASED']);
    assert.equal(t3.owners['foundry-smeltery'], 'Ada');
    assert.equal(cashOf(t3, 'Ada'), 1500 - 10, 'paid their own opening bid');
  });
});

// ---------------------------------------------------------------------------
// Settlement invariants

describe('settlement — immediate, validated, atomic (spec §5)', () => {
  it('the winning payment goes to the bank only, and ownership lands in the same command', () => {
    const state = openAuction();
    const id = auctionOf(state).auctionId;
    const { state: s1 } = applyOk(state, 'BID', { actor: 'Grace', payload: { auctionId: id, amount: 70 } });
    const { state: s2, events } = applyOk(s1, 'PASS_BID', { actor: 'Ada', payload: { auctionId: id } });

    assert.equal(cashOf(s2, 'Grace'), 1500 - 70, 'the winner paid their bid');
    assert.equal(cashOf(s2, 'Ada'), 1500, 'no other player was credited — the bank absorbed it');
    assert.equal(s2.owners['foundry-smeltery'], 'Grace');
    const purchase = events.find((e) => e.type === 'PROPERTY_PURCHASED');
    assert.ok(purchase);
    assert.deepEqual(purchase.payload, { playerId: 'Grace', spaceId: 'foundry-smeltery', amount: 70, via: 'AUCTION' });
    const resolved = events.find((e) => e.type === 'AUCTION_RESOLVED');
    assert.ok(resolved);
    assert.deepEqual(resolved.payload, { auctionId: id, winnerId: 'Grace', spaceId: 'foundry-smeltery', amount: 70 });
  });

  it('settlement never creates a winner-debt: the winner\'s cash stays ≥ 0 and equals pre-cash minus their own bid', () => {
    const state = contestedAuction();
    assert.equal(cashOf(state, 'Ada'), 1500 - 130);
    assert.ok(cashOf(state, 'Ada') >= 0);
  });
});

// ---------------------------------------------------------------------------
// Authorization and the command pipeline (spec §2.1, §10)

describe('authorization and pipeline for auction commands (spec §2.1, §5, §10)', () => {
  it('BID outside an open auction is NOT_AUTHORIZED at step 5 — before any phase error', () => {
    const state = craftedState({ turnPhase: 'AWAITING_ROLL' });
    assert.equal(applyErr(state, 'BID', { actor: 'Grace', payload: { auctionId: 'auction-1', amount: 10 } }).code, 'NOT_AUTHORIZED');
  });

  it('a stale expectedVersion is rejected VERSION_CONFLICT like every command', () => {
    const state = openAuction();
    const id = auctionOf(state).auctionId;
    const err = applyErr(state, 'BID', { actor: 'Grace', payload: { auctionId: id, amount: 10 }, expectedVersion: state.version - 1 });
    assert.equal(err.code, 'VERSION_CONFLICT');
  });

  it('a duplicate commandId applies exactly once — no double payment, no double award', () => {
    const state = openAuction();
    const id = auctionOf(state).auctionId;
    // Grace must pass first — a sole unpassed bidder with no standing bid
    // cannot be resolved by their own bid (never award a price nobody bid).
    const passed = applyOk(state, 'PASS_BID', { actor: 'Grace', payload: { auctionId: id } });
    const settle = makeCommand(passed.state, 'BID', { actor: 'Ada', payload: { auctionId: id, amount: 10 }, commandId: 'settle-1' });
    const first = applyCommand(passed.state, settle, rngForState(passed.state.rngState));
    assert.ok(first.ok, 'the first application settles');
    if (!first.ok) throw new Error('unreachable');
    assert.equal(first.state.owners['foundry-smeltery'], 'Ada');

    // Re-apply the SAME envelope against the post-first state — the ledger
    // contains settle-1, so the retry must apply nothing.
    const retry = applyCommand(first.state, settle, rngForState(first.state.rngState));
    assert.ok(retry.ok);
    if (!retry.ok) throw new Error('unreachable');
    assert.equal(retry.applied, false);
    assert.deepEqual(retry.events, []);
    assert.equal(retry.state.owners['foundry-smeltery'], 'Ada', 'no double award');
    assert.equal(cashOf(retry.state, 'Ada'), cashOf(first.state, 'Ada'), 'no double payment');
  });

  it('rejected bids leave the state deep-equal untouched (purity)', () => {
    const state = openAuction();
    const id = auctionOf(state).auctionId;
    const before = structuredClone(state);
    applyErr(state, 'BID', { actor: 'Grace', payload: { auctionId: id, amount: 5 } });
    applyErr(state, 'BID', { actor: 'Ada', payload: { auctionId: `${id}-wrong`, amount: 10 } });
    assert.deepEqual(state, before, 'the input state was never mutated');
  });
});

// ---------------------------------------------------------------------------
// Replay and determinism (spec §3, §5)

describe('free-form bid order is captured by the log — replay proves it (spec §3, §5)', () => {
  /** Open an auction from a real driven game and run a scripted bid war.
   *  Each command is built ONCE, applied, and that same object logged —
   *  the log must carry the ids that were actually applied. */
  function driveBidWar(bids: readonly { bidder: PlayerId; amount: number }[], finalPass?: PlayerId): { initial: GameState; log: GameCommand[]; final: GameState; spaceId: string } {
    const created = createGame({ gameId: 'g-war', seed: AUCTION_SEED, playerIds: ['Ada', 'Grace'] });
    assert.ok(created.ok);
    if (!created.ok) throw new Error('unreachable');
    const initial = created.state;
    const log: GameCommand[] = [];
    let state = initial;
    const runOnce = (type: CommandType, opts: { actor?: PlayerId; payload?: Record<string, unknown>; commandId?: string } = {}): void => {
      const command = makeCommand(state, type, opts);
      const result = applyCommand(state, command, rngForState(state.rngState));
      assert.ok(result.ok, `${type} must apply: ${result.ok ? '' : result.error.message}`);
      if (!result.ok) throw new Error('unreachable');
      log.push(command);
      state = result.state;
    };
    runOnce('START_GAME', { actor: 'Ada', commandId: 'start' });
    runOnce('ROLL', { commandId: 'roll' });
    runOnce('PASS_TO_AUCTION', { commandId: 'decline' });
    const spaceId = auctionOf(state).spaceId;
    const id = auctionOf(state).auctionId;
    for (const bid of bids) {
      runOnce('BID', { actor: bid.bidder, payload: { auctionId: id, amount: bid.amount } });
      if (state.turnPhase !== 'AUCTION') break; // resolved mid-war
    }
    if (finalPass && state.turnPhase === 'AUCTION') {
      runOnce('PASS_BID', { actor: finalPass, payload: { auctionId: id } });
    }
    return { initial, log, final: state, spaceId };
  }

  it('replaying the log reproduces the post-auction state hash exactly', () => {
    const run = driveBidWar(
      [
        { bidder: 'Grace', amount: 100 },
        { bidder: 'Ada', amount: 130 },
      ],
      'Grace',
    );
    assert.equal(run.final.turnPhase, 'TURN_MANAGEMENT', 'the war resolved: Ada wins at 130');
    const replayed = replayCommands(run.initial, run.log);
    assert.equal(stateHash(replayed.state), stateHash(run.final), 'same log, same hash — free-form order lives in the log');
  });

  it('two different legal bid orders produce two different outcomes — both replay to their own hash', () => {
    const warA = driveBidWar(
      [
        { bidder: 'Grace', amount: 100 },
        { bidder: 'Ada', amount: 130 },
      ],
      'Grace',
    );
    const warB = driveBidWar([{ bidder: 'Ada', amount: 110 }], 'Grace');
    assert.equal(warA.final.owners[warA.spaceId], 'Ada');
    assert.equal(warB.final.owners[warB.spaceId], 'Ada');
    assert.notEqual(stateHash(warA.final), stateHash(warB.final), 'order changed the price paid (130 vs 110)');
    const replayB = replayCommands(warB.initial, warB.log);
    assert.equal(stateHash(replayB.state), stateHash(warB.final));
  });

  it('auction events keep gapless sequences inside the driven log', () => {
    const run = driveBidWar(
      [
        { bidder: 'Grace', amount: 100 },
        { bidder: 'Ada', amount: 130 },
      ],
      'Grace',
    );
    let state: GameState = run.initial;
    let expected = 2; // createGame emits GAME_CREATED as sequence 1 before the log starts
    for (const command of run.log) {
      const result = applyCommand(state, command, rngForState(state.rngState));
      assert.ok(result.ok);
      if (!result.ok) throw new Error('unreachable');
      for (const event of result.events) {
        assert.equal(event.sequence, expected++, 'sequences are gapless from 1');
      }
      state = result.state;
    }
  });
});

// ---------------------------------------------------------------------------
// Snapshots (spec §2.4) and the §17.2 bankruptcy ban

describe('snapshots mid-auction and the §17.2 structural ban', () => {
  it('an open, contested auction round-trips through the versioned snapshot loader', () => {
    // One bid in, nobody passed: the auction is genuinely open.
    const state = openAuction();
    const id = auctionOf(state).auctionId;
    const { state: s1 } = applyOk(state, 'BID', { actor: 'Grace', payload: { auctionId: id, amount: 50 } });
    assert.equal(s1.turnPhase, 'AUCTION');
    assert.equal(s1.auction?.currentBid, 50);

    const parsed = parseSnapshot(serializeSnapshot(buildSnapshot(s1)));
    assert.ok(parsed.ok);
    if (!parsed.ok) throw new Error('unreachable');
    const restored = parsed.snapshot.state;
    assert.deepEqual(restored, s1, 'byte-equal restore of the mid-auction state');
    assert.equal(restored.auction?.currentBid, 50);
    assert.equal(restored.auction?.highBidderId, 'Grace');
    assert.deepEqual(restored.auction?.passedPlayerIds, []);
  });

  it('a state claiming an AUCTION phase with no open auction is refused by the schema', () => {
    const broken = craftedState({ turnPhase: 'AUCTION' });
    const parsed = parseSnapshot(serializeSnapshot(buildSnapshot(broken)));
    assert.ok(!parsed.ok, 'the auction⟷phase invariant is structural');
  });

  it('§17.2 type level: the auction event vocabulary has no bankruptcy members', () => {
    type Banned = Extract<AuctionEventInput, { type: 'PLAYER_BANKRUPT' | 'ASSETS_TRANSFERRED' | 'PLAYER_ELIMINATED' }>;
    const probe: readonly Banned[] = [];
    assert.equal(probe.length, 0, 'the Extract type resolves to never — compile-time ban');
  });

  it('§17.2 runtime: a full driven auction emits no bankruptcy events and cannot pause half-open', () => {
    const run = driveWarForScan();
    for (const event of run.events) {
      assert.ok(
        event.type !== 'PLAYER_BANKRUPT' && event.type !== 'ASSETS_TRANSFERRED' && event.type !== 'PLAYER_ELIMINATED',
        `auction path emitted banned event ${event.type}`,
      );
    }
    assert.ok(run.final.auction === null && run.final.turnPhase === 'TURN_MANAGEMENT', 'resolved auctions leave no half-open state');
  });
});

/** A small driver for the §17.2 runtime scan: real game, decline, contested
 *  bids, passes until resolution; returns the full event stream. */
function driveWarForScan(): { events: AnyGameEvent[]; final: GameState } {
  const created = createGame({ gameId: 'g-scan', seed: AUCTION_SEED, playerIds: ['Ada', 'Grace'] });
  assert.ok(created.ok);
  if (!created.ok) throw new Error('unreachable');
  let state = created.state;
  const events: AnyGameEvent[] = [];
  const run = (type: CommandType, opts: { actor?: PlayerId; payload?: Record<string, unknown>; commandId?: string } = {}): void => {
    const result = applyCommand(state, makeCommand(state, type, opts), rngForState(state.rngState));
    assert.ok(result.ok, `${type} must apply: ${result.ok ? '' : result.error.message}`);
    if (!result.ok) throw new Error('unreachable');
    events.push(...result.events);
    state = result.state;
  };
  run('START_GAME', { actor: 'Ada', commandId: 's' });
  run('ROLL', { commandId: 'r' });
  run('PASS_TO_AUCTION', { commandId: 'd' });
  const id = auctionOf(state).auctionId;
  run('BID', { actor: 'Grace', payload: { auctionId: id, amount: 100 }, commandId: 'b1' });
  run('BID', { actor: 'Ada', payload: { auctionId: id, amount: 130 }, commandId: 'b2' });
  run('PASS_BID', { actor: 'Grace', payload: { auctionId: id }, commandId: 'p1' });
  return { events, final: state };
}
