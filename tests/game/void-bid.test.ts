/**
 * VOID_BID — Phase 2's only engine addition (contract §3 row 3, spec
 * "Deadlines — timers that act like players").
 *
 * The server's deadline service voids a timed-out high bid: the bidder is out
 * of the auction (binding, like a pass), their pledge is released (bids are
 * cash-backed, never escrowed — no money moves), and bidding restarts from
 * the opening minimum. With no eligible bidders remaining the sale closes
 * unsold via the existing end path. The void is legal on both deadline-
 * governed surfaces — a declined buy's AUCTION and a bank-creditor estate's
 * ELIMINATION_AUCTIONS — and §17.2's structural pin holds: the auction event
 * vocabulary still contains no bankruptcy member.
 *
 * Pure-reducer tests per the established pattern (fixtures + real handlers).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CommandType, GameCommand } from '../../src/lib/game/commands';
import { applyCommand, canAct } from '../../src/lib/game/engine/reducer';
import { replayCommands, stateHash } from '../../src/lib/game/engine/replay';
import { rngForState } from '../../src/lib/game/rng';
import type { AnyGameEvent } from '../../src/lib/game/events';
import { BANK_ID, RULES_VERSION, type AuctionState, type GameState, type PlayerId, type PlayerState } from '../../src/lib/game/types';

// ---------------------------------------------------------------------------
// Helpers (per-file copies of the established pattern)

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

function eventTypes(events: readonly AnyGameEvent[]): string[] {
  return events.map((e) => e.type);
}

function cashOf(state: GameState, id: PlayerId): number {
  const player = state.players.find((p) => p.id === id);
  assert.ok(player);
  return player.cash;
}

function auctionOf(state: GameState): AuctionState {
  const auction = state.auction;
  assert.ok(auction, 'an open auction is exactly an open-auction phase');
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

/** Hand-build a mid-game state (same shape as the auction suite's fixture). */
function craftedState(overrides: {
  players?: PlayerState[];
  activePlayerId?: PlayerId | null;
  turnPhase?: GameState['turnPhase'];
  owners?: Record<string, PlayerId>;
  debt?: GameState['debt'];
  estateSale?: GameState['estateSale'];
} = {}): GameState {
  return {
    gameId: 'g-void',
    version: 7,
    phase: 'PLAYING',
    turnPhase: overrides.turnPhase ?? 'AWAITING_ROLL',
    mode: 'CLASSIC',
    doublesCount: 0,
    owners: overrides.owners ?? {},
    upgrades: {},
    mortgaged: {},
    eventDeck: { drawPile: [], discardPile: [] },
    debt: overrides.debt ?? null,
    auction: null,
    trade: null,
    estateSale: overrides.estateSale ?? null,
    rulesVersion: RULES_VERSION,
    seed: 1,
    rngState: 1,
    players: overrides.players ?? [mkPlayer({ id: 'Ada', seat: 0, position: 1 }), mkPlayer({ id: 'Grace', seat: 1 })],
    activePlayerId: overrides.activePlayerId !== undefined ? overrides.activePlayerId : 'Ada',
    turn: 3,
    round: 1,
    lastEventSequence: 40,
    processedCommandIds: [],
  };
}

/** An open auction on Ada's token space, produced by the real row-6 handler
 *  from a crafted BUY_DECISION — never hand-built: the reducer owns the
 *  auction id and the eligibility snapshot. */
function openAuction(opts: { players?: PlayerState[] } = {}): GameState {
  const state = craftedState({
    players: opts.players ?? [mkPlayer({ id: 'Ada', seat: 0, position: 1 }), mkPlayer({ id: 'Grace', seat: 1 })],
    turnPhase: 'BUY_DECISION',
  });
  const { state: s1 } = applyOk(state, 'PASS_TO_AUCTION');
  return s1;
}

/** An open auction with Grace's standing bid of 100. */
function contestedAuction(opts: { players?: PlayerState[] } = {}): { state: GameState; auctionId: string } {
  const state = openAuction(opts);
  const auctionId = auctionOf(state).auctionId;
  const { state: s1 } = applyOk(state, 'BID', { actor: 'Grace', payload: { auctionId, amount: 100 } });
  return { state: s1, auctionId };
}

/** A real bank-creditor estate: Ada surrenders, the bank takes the estate,
 *  and the first space's elimination auction opens (Grace + Ben eligible). */
function openEstateAuction(): { state: GameState; auctionId: string } {
  const base = craftedState({
    turnPhase: 'SETTLING_DEBT',
    debt: { debtorId: 'Ada', creditorId: BANK_ID, amountDue: 150, reason: 'RENT' },
    players: [mkPlayer({ id: 'Ada', seat: 0, cash: 20 }), mkPlayer({ id: 'Grace', seat: 1 }), mkPlayer({ id: 'Ben', seat: 2 })],
    owners: { 'foundry-anvil': 'Ada', 'hub-central-relay': 'Ada' },
    mortgaged: { 'foundry-anvil': true },
  });
  const { state: surrendered } = applyOk(base, 'SURRENDER');
  assert.equal(surrendered.turnPhase, 'ELIMINATION_AUCTIONS');
  const auction = auctionOf(surrendered);
  return { state: surrendered, auctionId: auction.auctionId };
}

// ---------------------------------------------------------------------------
// Authorization — the bank may only void; players never can

describe('VOID_BID authorization (canAct + pipeline step 2/5)', () => {
  it('the bank authorizes exactly with an open auction; a player never does', () => {
    const open = openAuction();
    const auctionId = auctionOf(open).auctionId;
    assert.equal(canAct(open, makeCommand(open, 'VOID_BID', { actor: BANK_ID, payload: { auctionId } })), true, 'bank + open auction');
    assert.equal(canAct(open, makeCommand(open, 'VOID_BID', { actor: 'Ada', payload: { auctionId } })), false, 'a player-claimed void never authorizes');
    const quiet = craftedState({ turnPhase: 'AWAITING_ROLL' });
    assert.equal(canAct(quiet, makeCommand(quiet, 'VOID_BID', { actor: BANK_ID, payload: { auctionId: 'a-1' } })), false, 'no open auction, no void');
  });

  it('the bank is not a player — a bank-acted BID or PASS_BID still dies at step 5', () => {
    const { state, auctionId } = contestedAuction();
    assert.equal(applyErrCode(state, 'BID', { actor: BANK_ID, payload: { auctionId, amount: 130 } }), 'NOT_AUTHORIZED', 'the bank can never bid');
    assert.equal(applyErrCode(state, 'PASS_BID', { actor: BANK_ID, payload: { auctionId } }), 'NOT_AUTHORIZED', 'the bank can never pass');
  });

  it('a player-claimed VOID_BID is rejected NOT_AUTHORIZED and leaves the state deep-equal unchanged', () => {
    const { state, auctionId } = contestedAuction();
    const before = structuredClone(state);
    assert.equal(applyErrCode(state, 'VOID_BID', { actor: 'Ada', payload: { auctionId } }), 'NOT_AUTHORIZED');
    assert.deepEqual(state, before, 'rejection purity');
  });
});

// ---------------------------------------------------------------------------
// The void mechanics on a declined-buy auction

describe('VOID_BID on a declined-buy auction (contract §3 row 3)', () => {
  it('voids the standing bid: event payload, bidder out, pledge released, no money moves', () => {
    const { state, auctionId } = contestedAuction();
    const cashBefore = cashOf(state, 'Grace');
    const result = applyOk(state, 'VOID_BID', { actor: BANK_ID, payload: { auctionId } });
    assert.deepEqual(eventTypes(result.events), ['AUCTION_BID_VOIDED']);
    const voided = result.events[0];
    assert.ok(voided.type === 'AUCTION_BID_VOIDED');
    assert.deepEqual(voided.payload, { auctionId, bidderId: 'Grace', amount: 100 });
    assert.equal(cashOf(result.state, 'Grace'), cashBefore, 'bids are never escrowed — the release moves no money');
    const auction = auctionOf(result.state);
    assert.equal(auction.currentBid, null, 'no standing bid remains');
    assert.equal(auction.highBidderId, null);
    assert.deepEqual(auction.passedPlayerIds, ['Grace'], 'the void is binding, like a pass');
    assert.equal(result.state.turnPhase, 'AUCTION', 'the auction continues');
  });

  it('the voided bidder cannot re-bid, and bidding restarts from the opening minimum', () => {
    const { state, auctionId } = contestedAuction();
    const voided = applyOk(state, 'VOID_BID', { actor: BANK_ID, payload: { auctionId } });
    assert.equal(applyErrCode(voided.state, 'BID', { actor: 'Grace', payload: { auctionId, amount: 110 } }), 'NOT_AUTHORIZED', 'binding');
    // Ada, the sole remaining bidder, opens at the fresh minimum — the
    // voided 100 is as if never made. Two players: her bid is the only bid,
    // so the sale resolves to her at $10 inside the same command.
    const reopened = applyOk(voided.state, 'BID', { actor: 'Ada', payload: { auctionId, amount: 10 } });
    assert.deepEqual(eventTypes(reopened.events), ['AUCTION_BID', 'AUCTION_RESOLVED', 'PROPERTY_PURCHASED']);
    assert.equal(cashOf(reopened.state, 'Ada'), 1500 - 10, 'she pays the fresh minimum, not the voided amount');
  });

  it('void leaves the sole remaining bidder with the open-only-bid-or-pass decision; their pass closes the sale unsold', () => {
    const { state, auctionId } = contestedAuction();
    const voided = applyOk(state, 'VOID_BID', { actor: BANK_ID, payload: { auctionId } });
    // Grace is out; Ada is the only unpassed player with no standing bid.
    const pass = applyOk(voided.state, 'PASS_BID', { actor: 'Ada', payload: { auctionId } });
    assert.deepEqual(eventTypes(pass.events), ['AUCTION_PASS', 'AUCTION_CLOSED_UNSOLD'], 'the existing end path closes the sale');
    assert.equal(pass.state.auction, null);
    assert.equal(pass.state.turnPhase, 'TURN_MANAGEMENT', "the decliner's turn resumes");
  });

  it('with a third bidder the auction continues contested after the void', () => {
    const players = [mkPlayer({ id: 'Ada', seat: 0, position: 1 }), mkPlayer({ id: 'Grace', seat: 1 }), mkPlayer({ id: 'Ben', seat: 2 })];
    const { state, auctionId } = contestedAuction({ players });
    const voided = applyOk(state, 'VOID_BID', { actor: BANK_ID, payload: { auctionId } });
    assert.equal(voided.state.turnPhase, 'AUCTION', 'Ben remains — the auction stays open');
    const bid = applyOk(voided.state, 'BID', { actor: 'Ben', payload: { auctionId, amount: 10 } });
    assert.equal(auctionOf(bid.state).currentBid, 10, 'bidding restarts from the opening minimum');
  });

  it('rejects a void with the wrong auction id, no standing bid, or no open auction', () => {
    const { state, auctionId } = contestedAuction();
    assert.equal(applyErrCode(state, 'VOID_BID', { actor: BANK_ID, payload: { auctionId: 'a-other' } }), 'RULE_VIOLATION', 'payload names another auction');
    void auctionId;
    // No standing bid: a freshly opened auction with nobody bidding yet.
    const fresh = openAuction();
    const freshId = auctionOf(fresh).auctionId;
    assert.equal(applyErrCode(fresh, 'VOID_BID', { actor: BANK_ID, payload: { auctionId: freshId } }), 'RULE_VIOLATION');
    // No open auction at all — authorization fails at step 5 before the
    // handler's phase check could name INVALID_PHASE (documented pipeline
    // order: with no open auction nobody is a bidder).
    const quiet = craftedState({ turnPhase: 'AWAITING_ROLL' });
    assert.equal(applyErrCode(quiet, 'VOID_BID', { actor: BANK_ID, payload: { auctionId: 'a-1' } }), 'NOT_AUTHORIZED');
  });
});

// ---------------------------------------------------------------------------
// The void in a bank-creditor estate auction

describe('VOID_BID in a bank-creditor estate auction (ELIMINATION_AUCTIONS)', () => {
  it('voids the standing bid and keeps the estate sale on the same space — no early advance', () => {
    const estate = openEstateAuction();
    const bid = applyOk(estate.state, 'BID', { actor: 'Grace', payload: { auctionId: estate.auctionId, amount: 100 } });
    const voided = applyOk(bid.state, 'VOID_BID', { actor: BANK_ID, payload: { auctionId: estate.auctionId } });
    assert.deepEqual(eventTypes(voided.events), ['AUCTION_BID_VOIDED']);
    const auction = auctionOf(voided.state);
    assert.equal(auction.spaceId, 'foundry-anvil', 'the same space is still on sale');
    assert.equal(voided.state.estateSale?.pendingSpaceIds.includes('hub-central-relay'), true, 'the sale has not advanced');
    assert.deepEqual(auction.passedPlayerIds, ['Grace'], 'Grace is out');
    // Ben is now the sole unpassed bidder: his opening bid at the fresh
    // minimum wins the space immediately and the sale advances to the next
    // space inside the same command.
    const bid2 = applyOk(voided.state, 'BID', { actor: 'Ben', payload: { auctionId: estate.auctionId, amount: 10 } });
    assert.deepEqual(eventTypes(bid2.events), ['AUCTION_BID', 'AUCTION_RESOLVED', 'PROPERTY_PURCHASED', 'AUCTION_OPENED']);
    assert.equal(cashOf(bid2.state, 'Ben'), 1500 - 10, 'he pays the fresh minimum, not the voided amount');
    assert.equal(bid2.state.owners['foundry-anvil'], 'Ben');
  });

  it('after a void, the last remaining bidder passing closes the space unsold and advances the estate sale', () => {
    const estate = openEstateAuction();
    const bid = applyOk(estate.state, 'BID', { actor: 'Grace', payload: { auctionId: estate.auctionId, amount: 100 } });
    const voided = applyOk(bid.state, 'VOID_BID', { actor: BANK_ID, payload: { auctionId: estate.auctionId } });
    const pass = applyOk(voided.state, 'PASS_BID', { actor: 'Ben', payload: { auctionId: estate.auctionId } });
    assert.deepEqual(eventTypes(pass.events), ['AUCTION_PASS', 'AUCTION_CLOSED_UNSOLD', 'AUCTION_OPENED'], 'the estate sale opens the next space');
    assert.equal(auctionOf(pass.state).spaceId, 'hub-central-relay');
  });
});

// ---------------------------------------------------------------------------
// Replay and the §17.2 structural pin

describe('VOID_BID replay coverage and the §17.2 pin', () => {
  it('a deadline-void sequence replays bit-for-bit from the event history', () => {
    const initial = openAuction();
    const auctionId = auctionOf(initial).auctionId;
    // Compose each command against the live state as the drive advances (the
    // version guard), replay the collected commands from the initial state.
    const plan: Array<{ type: CommandType; opts: { actor?: PlayerId; payload?: Record<string, unknown>; commandId?: string } }> = [
      { type: 'BID', opts: { actor: 'Grace', payload: { auctionId, amount: 100 }, commandId: 'b1' } },
      { type: 'VOID_BID', opts: { actor: BANK_ID, payload: { auctionId }, commandId: 'sv1' } },
      { type: 'PASS_BID', opts: { actor: 'Ada', payload: { auctionId }, commandId: 'p1' } },
    ];
    const commands: GameCommand[] = [];
    let live = initial;
    for (const { type, opts } of plan) {
      const command = makeCommand(live, type, opts);
      const result = applyCommand(live, command, rngForState(live.rngState));
      assert.ok(result.ok, `${type} must apply in the live drive: ${result.ok ? '' : result.error.message}`);
      if (!result.ok) throw new Error('unreachable');
      live = result.state;
      commands.push(command);
    }
    const replay = replayCommands(initial, commands);
    assert.deepEqual(replay.rejected, []);
    assert.equal(stateHash(live), stateHash(replay.state), 'replay reproduces the void sequence exactly');
  });

  it('an idempotent retry of a deadline-void commandId applies nothing (the ledger replays stored events at the transport layer)', () => {
    const { state, auctionId } = contestedAuction();
    const first = applyOk(state, 'VOID_BID', { actor: BANK_ID, payload: { auctionId }, commandId: 'sv-retry' });
    const retry = applyCommand(first.state, makeCommand(first.state, 'VOID_BID', { actor: BANK_ID, payload: { auctionId }, commandId: 'sv-retry' }), rngForState(first.state.rngState));
    assert.ok(retry.ok, 'the retry must succeed idempotently');
    if (!retry.ok) throw new Error('unreachable');
    assert.equal(retry.applied, false, 'the ledger absorbs the retry');
    assert.deepEqual(retry.events, [], 'the reducer emits nothing; LocalCommandSink and the server ledger return the stored events');
    assert.equal(stateHash(retry.state), stateHash(first.state), 'the state is unchanged');
  });

  it('§17.2 runtime: the void path emits no bankruptcy events', () => {
    const estate = openEstateAuction();
    const bid = applyOk(estate.state, 'BID', { actor: 'Grace', payload: { auctionId: estate.auctionId, amount: 100 } });
    const voided = applyOk(bid.state, 'VOID_BID', { actor: BANK_ID, payload: { auctionId: estate.auctionId } });
    for (const event of [...bid.events, ...voided.events]) {
      assert.ok(
        event.type !== 'PLAYER_BANKRUPT' && event.type !== 'ASSETS_TRANSFERRED' && event.type !== 'PLAYER_ELIMINATED',
        `void path emitted banned event ${event.type}`,
      );
    }
  });
});
