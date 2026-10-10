import type { EndgameEventInput } from '../../src/lib/game/engine/endgame';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CommandType, GameCommand } from '../../src/lib/game/commands';
import type { AnyGameEvent } from '../../src/lib/game/events';
import { stateHash, replayCommands } from '../../src/lib/game/engine/replay';
import { applyCommand } from '../../src/lib/game/engine/reducer';
import { rngForState } from '../../src/lib/game/rng';
import { MODES } from '../../src/lib/game/board-v1';
import {
  BANK_ID,
  RULES_VERSION,
  SNAPSHOT_SCHEMA_VERSION,
  type DebtState,
  type GameState,
  type PendingTradeState,
  type PlayerId,
  type PlayerState,
} from '../../src/lib/game/types';

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

function eventTypes(events: readonly AnyGameEvent[]): string[] {
  return events.map((e) => e.type);
}

function cashOf(state: GameState, id: PlayerId): number {
  const player = state.players.find((p) => p.id === id);
  assert.ok(player, `player ${id} must exist`);
  return player.cash;
}

function playerOf(state: GameState, id: PlayerId): PlayerState {
  const player = state.players.find((p) => p.id === id);
  assert.ok(player, `player ${id} must exist`);
  return player;
}

interface CraftedOverrides {
  players?: PlayerState[];
  activePlayerId?: PlayerId | null;
  turnPhase?: GameState['turnPhase'];
  phase?: GameState['phase'];
  mode?: GameState['mode'];
  round?: number;
  turn?: number;
  owners?: Record<string, PlayerId>;
  upgrades?: Record<string, number>;
  mortgaged?: Record<string, boolean>;
  debt?: DebtState | null;
  trade?: PendingTradeState | null;
  processedCommandIds?: string[];
}

/** Hand-build a PLAYING state. Three seats by default: Ada (0), Grace (1),
 *  Ben (2) — a bankruptcy with three live players leaves a game running, so
 *  the estate sale and handover paths actually execute. */
function craftedState(overrides: CraftedOverrides = {}): GameState {
  return {
    gameId: 'g-end',
    version: 7,
    phase: overrides.phase ?? 'PLAYING',
    turnPhase: overrides.turnPhase ?? 'TURN_MANAGEMENT',
    mode: overrides.mode ?? 'CLASSIC',
    doublesCount: 0,
    owners: overrides.owners ?? {},
    upgrades: overrides.upgrades ?? {},
    mortgaged: overrides.mortgaged ?? {},
    eventDeck: { drawPile: [], discardPile: [] },
    debt: overrides.debt ?? null,
    auction: null,
    trade: overrides.trade ?? null,
    estateSale: null,
    rulesVersion: RULES_VERSION,
    seed: 1,
    rngState: 1,
    players: overrides.players ?? [mkPlayer({ id: 'Ada', seat: 0 }), mkPlayer({ id: 'Grace', seat: 1 }), mkPlayer({ id: 'Ben', seat: 2 })],
    activePlayerId: overrides.activePlayerId ?? overrides.players?.[0]?.id ?? 'Ada',
    turn: overrides.turn ?? 3,
    round: overrides.round ?? 1,
    lastEventSequence: 10,
    processedCommandIds: overrides.processedCommandIds ?? [],
  } as GameState;
}

/** A settling state: Ada owes the bank $150 (hopeless — cash is short and no
 *  liquidation can close the gap), owning the mortgaged Anvil ($100) and the
 *  Central Relay hub ($200). Anvil is board-ordered before the hub. */
function bankEstateState(): GameState {
  return craftedState({
    turnPhase: 'SETTLING_DEBT',
    debt: { debtorId: 'Ada', creditorId: BANK_ID, amountDue: 150, reason: 'RENT' },
    players: [mkPlayer({ id: 'Ada', seat: 0, cash: 20 }), mkPlayer({ id: 'Grace', seat: 1 }), mkPlayer({ id: 'Ben', seat: 2 })],
    owners: { 'foundry-anvil': 'Ada', 'hub-central-relay': 'Ada' },
    mortgaged: { 'foundry-anvil': true },
  });
}

describe('endgame — the bankruptcy waterfall, player creditor (spec §7)', () => {
  it('transfers cash, salvage, and mortgaged property to the creditor in board order', () => {
    // Ada owes Grace $150 rent. Her estate: cash $100, the Anvil at level 2
    // (salvage 2 × $25), the mortgaged Smeltery (flag must survive intact).
    const state = craftedState({
      turnPhase: 'SETTLING_DEBT',
      debt: { debtorId: 'Ada', creditorId: 'Grace', amountDue: 150, reason: 'RENT' },
      players: [mkPlayer({ id: 'Ada', seat: 0, cash: 100 }), mkPlayer({ id: 'Grace', seat: 1 }), mkPlayer({ id: 'Ben', seat: 2 })],
      owners: { 'foundry-smeltery': 'Ada', 'foundry-anvil': 'Ada' },
      upgrades: { 'foundry-anvil': 2 },
      mortgaged: { 'foundry-smeltery': true },
    });
    const result = applyOk(state, 'SURRENDER');
    assert.deepEqual(eventTypes(result.events), ['PLAYER_BANKRUPT', 'ASSETS_TRANSFERRED', 'PLAYER_ELIMINATED', 'TURN_ENDED', 'TURN_STARTED']);
    const bankrupt = result.events[0];
    assert.ok(bankrupt.type === 'PLAYER_BANKRUPT');
    assert.deepEqual(bankrupt.payload, { playerId: 'Ada', creditorId: 'Grace' });
    const transferred = result.events[1];
    assert.ok(transferred.type === 'ASSETS_TRANSFERRED');
    // Liquid: $100 cash + 2 levels × $25 salvage = $150; spaces in board order.
    assert.deepEqual(transferred.payload, { fromId: 'Ada', toId: 'Grace', cash: 150, spaceIds: ['foundry-smeltery', 'foundry-anvil'] });
    assert.equal(cashOf(result.state, 'Ada'), 0);
    assert.equal(cashOf(result.state, 'Grace'), 1500 + 150);
    assert.equal(playerOf(result.state, 'Ada').eliminated, true);
    assert.deepEqual(playerOf(result.state, 'Ada').tokens, { HOLD: 0, RENT_HOLIDAY: 0 }, 'tokens are discarded');
    // Mortgages transfer intact (§7 step 3) — Grace may unmortgage at 110%.
    assert.equal(result.state.mortgaged['foundry-smeltery'], true);
    assert.equal(result.state.owners['foundry-smeltery'], 'Grace');
    assert.equal(result.state.owners['foundry-anvil'], 'Grace');
    assert.equal('foundry-anvil' in result.state.upgrades, false, 'built levels are liquidated, not transferred');
    assert.equal(result.state.debt, null);
    // The bankrupt turn ends without a management phase; Grace rolls next.
    assert.equal(result.state.turnPhase, 'AWAITING_ROLL');
    assert.equal(result.state.activePlayerId, 'Grace');
    assert.equal(result.state.turn, 4);
  });

  it('replays the waterfall bit-for-bit from the event history', () => {
    const state = craftedState({
      turnPhase: 'SETTLING_DEBT',
      debt: { debtorId: 'Ada', creditorId: 'Grace', amountDue: 150, reason: 'RENT' },
      players: [mkPlayer({ id: 'Ada', seat: 0, cash: 100 }), mkPlayer({ id: 'Grace', seat: 1 }), mkPlayer({ id: 'Ben', seat: 2 })],
      owners: { 'foundry-smeltery': 'Ada', 'foundry-anvil': 'Ada' },
      upgrades: { 'foundry-anvil': 2 },
      mortgaged: { 'foundry-smeltery': true },
    });
    const initial = structuredClone(state);
    const live = applyCommand(state, makeCommand(state, 'SURRENDER'), rngForState(state.rngState));
    assert.ok(live.ok, 'SURRENDER must apply');
    if (!live.ok) return;
    const replay = replayCommands(initial, [makeCommand(initial, 'SURRENDER', { commandId: (live.state.processedCommandIds.at(-1) ?? '') })]);
    assert.deepEqual(replay.rejected, []);
    assert.equal(stateHash(live.state), stateHash(replay.state), 'replay reproduces the waterfall state exactly');
  });
});

describe('endgame — elimination auctions, bank creditor (spec §7 step 5, §4 row 16)', () => {
  it('enters ELIMINATION_AUCTIONS and opens the estate\u2019s first auction in board order', () => {
    const result = applyOk(bankEstateState(), 'SURRENDER');
    assert.deepEqual(eventTypes(result.events), ['PLAYER_BANKRUPT', 'ASSETS_TRANSFERRED', 'PLAYER_ELIMINATED', 'AUCTION_OPENED']);
    const transferred = result.events[1];
    assert.ok(transferred.type === 'ASSETS_TRANSFERRED');
    // Cash to the bank with no salvage (no built levels); spaces leave
    // `owners` for the estate sale; the mortgage flag dies with the
    // ownership — the bank cannot hold a loan against an unowned space.
    assert.deepEqual(transferred.payload, { fromId: 'Ada', toId: BANK_ID, cash: 20, spaceIds: ['foundry-anvil', 'hub-central-relay'] });
    assert.equal('foundry-anvil' in result.state.owners, false);
    assert.equal('foundry-anvil' in result.state.mortgaged, false);
    assert.equal(result.state.turnPhase, 'ELIMINATION_AUCTIONS');
    assert.deepEqual(result.state.estateSale, { debtorId: 'Ada', pendingSpaceIds: ['hub-central-relay'] });
    assert.ok(result.state.auction, 'the first estate auction is open');
    // §5 eligibility frozen at open: live players only — the eliminated
    // debtor cannot bid on their own former estate. PLAYER_ELIMINATED is
    // emitted before AUCTION_OPENED for exactly this reason.
    assert.equal(result.state.auction.eligiblePlayerIds.includes('Ada'), false);
    assert.deepEqual(result.state.auction.eligiblePlayerIds, ['Grace', 'Ben']);
    assert.equal(result.state.auction.reason, 'BANK_ESTATE');
    assert.equal(result.state.auction.spaceId, 'foundry-anvil');
    assert.equal(applyErrCode(result.state, 'BID', { actor: 'Ada', payload: { auctionId: result.state.auction.auctionId, amount: 10 } }), 'NOT_AUTHORIZED');
  });

  it('runs the estate sale sequentially — contested bid, resolution, next space, unsold return', () => {
    let state = applyOk(bankEstateState(), 'SURRENDER').state;
    const firstAuctionId = state.auction?.auctionId;
    assert.ok(firstAuctionId);
    // Grace opens at $10; Ben has not passed, so the auction stays contested —
    // the next estate space must NOT open while this one is live.
    const bid = applyOk(state, 'BID', { actor: 'Grace', payload: { auctionId: firstAuctionId, amount: 10 } });
    state = bid.state;
    assert.equal(state.auction?.spaceId, 'foundry-anvil', 'a contested bid leaves the current auction open');
    assert.equal(state.turnPhase, 'ELIMINATION_AUCTIONS');
    // Ben passes: Grace is the only unpassed bidder and wins at $10, paid now.
    const pass = applyOk(state, 'PASS_BID', { actor: 'Ben', payload: { auctionId: firstAuctionId } });
    state = pass.state;
    assert.deepEqual(eventTypes(pass.events), ['AUCTION_PASS', 'AUCTION_RESOLVED', 'PROPERTY_PURCHASED', 'AUCTION_OPENED']);
    assert.equal(cashOf(state, 'Grace'), 1500 - 10, 'the winning bid is paid inside the resolving command');
    assert.equal(state.owners['foundry-anvil'], 'Grace');
    // The second estate space opens — the Anvil's auctionId must differ.
    assert.equal(state.auction?.spaceId, 'hub-central-relay');
    assert.notEqual(state.auction?.auctionId, firstAuctionId);
    const secondAuctionId = state.auction?.auctionId;
    assert.ok(secondAuctionId);
    // All pass on the hub: unsold — the space returns to the bank unowned,
    // then the interrupted turn ends and play resumes with Grace.
    const p1 = applyOk(state, 'PASS_BID', { actor: 'Grace', payload: { auctionId: secondAuctionId } });
    state = p1.state;
    assert.equal(state.auction?.spaceId, 'hub-central-relay', 'one unpassed player with no standing bid keeps the auction open');
    const p2 = applyOk(state, 'PASS_BID', { actor: 'Ben', payload: { auctionId: secondAuctionId } });
    state = p2.state;
    assert.deepEqual(eventTypes(p2.events), ['AUCTION_PASS', 'AUCTION_CLOSED_UNSOLD', 'TURN_ENDED', 'TURN_STARTED']);
    assert.equal('hub-central-relay' in state.owners, false, 'the unsold estate space is unowned — returned to the bank');
    assert.equal(state.estateSale, null);
    assert.equal(state.auction, null);
    assert.equal(state.turnPhase, 'AWAITING_ROLL');
    assert.equal(state.activePlayerId, 'Grace');
  });

  it('replays the whole estate sale bit-for-bit', () => {
    // Script the flow once, capturing every composed command verbatim (ids
    // and expectedVersions included — both live in the state hash), then
    // refold the same log from the same initial state.
    const log: GameCommand[] = [];
    const runStep = (state: GameState, type: CommandType, opts: { actor?: PlayerId; payload?: Record<string, unknown> } = {}): GameState => {
      const command = makeCommand(state, type, opts);
      const result = applyCommand(state, command, rngForState(state.rngState));
      assert.ok(result.ok, `${type} must apply: ${result.ok ? '' : result.error.message}`);
      if (!result.ok) throw new Error('unreachable');
      log.push(command);
      return result.state;
    };
    let state = runStep(bankEstateState(), 'SURRENDER');
    const id1 = state.auction?.auctionId ?? '';
    state = runStep(state, 'BID', { actor: 'Grace', payload: { auctionId: id1, amount: 10 } });
    state = runStep(state, 'PASS_BID', { actor: 'Ben', payload: { auctionId: id1 } });
    const id2 = state.auction?.auctionId ?? '';
    state = runStep(state, 'PASS_BID', { actor: 'Grace', payload: { auctionId: id2 } });
    state = runStep(state, 'PASS_BID', { actor: 'Ben', payload: { auctionId: id2 } });
    const replay = replayCommands(bankEstateState(), log);
    assert.deepEqual(replay.rejected, [], 'every scripted command applies cleanly');
    assert.equal(replay.appliedCount, log.length);
    assert.equal(stateHash(state), stateHash(replay.state), 'the estate sale replays to an identical state hash');
  });
});

describe('endgame — SURRENDER variants (spec §7, §4 rows 11/15)', () => {
  it('voluntary surrender in TURN_MANAGEMENT gives the bank the estate; last solvent wins', () => {
    const state = craftedState({
      players: [mkPlayer({ id: 'Ada', seat: 0, cash: 500 }), mkPlayer({ id: 'Grace', seat: 1 })],
      owners: { 'foundry-anvil': 'Ada' },
    });
    const result = applyOk(state, 'SURRENDER');
    assert.deepEqual(eventTypes(result.events), ['PLAYER_BANKRUPT', 'ASSETS_TRANSFERRED', 'PLAYER_ELIMINATED', 'VICTORY_DECIDED', 'GAME_ENDED']);
    const bankrupt = result.events[0];
    assert.ok(bankrupt.type === 'PLAYER_BANKRUPT');
    assert.equal(bankrupt.payload.creditorId, BANK_ID, 'no debt — the bank takes the estate');
    // Two players: elimination makes Grace the last solvent player, so the
    // game ends before any estate sale could open (§4 row 17).
    const victory = result.events[3];
    assert.ok(victory.type === 'VICTORY_DECIDED');
    assert.deepEqual(victory.payload, { winnerIds: ['Grace'], reason: 'LAST_SOLVENT' });
    assert.equal(result.state.phase, 'GAME_OVER');
    assert.equal(result.state.turnPhase, null);
  });

  it('guards: only the debtor may surrender a debt, only the active player otherwise, only in legal phases', () => {
    const settling = craftedState({
      turnPhase: 'SETTLING_DEBT',
      debt: { debtorId: 'Ada', creditorId: 'Grace', amountDue: 150, reason: 'RENT' },
    });
    assert.equal(applyErrCode(settling, 'SURRENDER', { actor: 'Grace' }), 'NOT_AUTHORIZED');
    const managing = craftedState({ activePlayerId: 'Ada' });
    assert.equal(applyErrCode(managing, 'SURRENDER', { actor: 'Grace' }), 'NOT_AUTHORIZED');
    const rolling = craftedState({ turnPhase: 'AWAITING_ROLL' });
    assert.equal(applyErrCode(rolling, 'SURRENDER'), 'INVALID_PHASE');
  });

  it('rejects every command after the game has ended (§4 row 17)', () => {
    const state = craftedState({
      players: [mkPlayer({ id: 'Ada', seat: 0, cash: 500 }), mkPlayer({ id: 'Grace', seat: 1 })],
      owners: { 'foundry-anvil': 'Ada' },
    });
    const ended = applyOk(state, 'SURRENDER').state;
    assert.equal(ended.phase, 'GAME_OVER');
    assert.equal(applyErrCode(ended, 'END_TURN'), 'GAME_IS_OVER');
    assert.equal(applyErrCode(ended, 'BUILD', { payload: { spaceId: 'foundry-anvil' } }), 'GAME_IS_OVER');
  });
});

describe('endgame — pending trades die (or survive) with elimination (spec §7 step 7)', () => {
  const OFFER: PendingTradeState = {
    tradeId: 'trade-1',
    proposerId: 'Ada',
    recipientId: 'Grace',
    offer: { give: { cash: 0, spaceIds: ['foundry-anvil'] }, receive: { cash: 100, spaceIds: [] } },
    anchorTurn: 3,
  };
  const UNINVOLVED_OFFER: PendingTradeState = { ...OFFER, proposerId: 'Grace', recipientId: 'Ben' };

  it('cancels a pending offer involving the eliminated player', () => {
    const state = craftedState({
      players: [mkPlayer({ id: 'Ada', seat: 0, cash: 500 }), mkPlayer({ id: 'Grace', seat: 1 })],
      owners: { 'foundry-anvil': 'Ada' },
      trade: OFFER,
    });
    const result = applyOk(state, 'SURRENDER');
    assert.ok(eventTypes(result.events).includes('TRADE_CANCELLED'), 'the offer dies with Ada');
    assert.equal(result.state.trade, null);
    const cancelled = result.events.find((e): e is Extract<AnyGameEvent, { type: 'TRADE_CANCELLED' }> => e.type === 'TRADE_CANCELLED');
    assert.ok(cancelled);
    assert.deepEqual(cancelled.payload, { tradeId: 'trade-1', reason: 'PARTY_INELIGIBLE' });
  });

  it('leaves offers between survivors untouched by another player\u2019s elimination', () => {
    const state = craftedState({
      players: [mkPlayer({ id: 'Ada', seat: 0, cash: 500 }), mkPlayer({ id: 'Grace', seat: 1 }), mkPlayer({ id: 'Ben', seat: 2 })],
      owners: { 'foundry-anvil': 'Ada' },
      trade: UNINVOLVED_OFFER,
    });
    const result = applyOk(state, 'SURRENDER');
    assert.equal(eventTypes(result.events).includes('TRADE_CANCELLED'), false);
    assert.deepEqual(result.state.trade, UNINVOLVED_OFFER);
  });
});

describe('endgame — victory conditions (spec §8)', () => {
  it('NET_WORTH_TARGET is decided by the canonical net worth, not raw cash', () => {
    // Both players hold $5,900 cash — below the $6,000 CLASSIC target. Ada's
    // Anvil equity (face $100) puts her canonical net worth exactly at the
    // target; a cash-only scorer would have ended nothing.
    const state = craftedState({
      players: [mkPlayer({ id: 'Ada', seat: 0, cash: 5900 }), mkPlayer({ id: 'Grace', seat: 1, cash: 5900 })],
      owners: { 'foundry-anvil': 'Ada' },
    });
    const result = applyOk(state, 'END_TURN');
    assert.deepEqual(eventTypes(result.events), ['TURN_ENDED', 'VICTORY_DECIDED', 'GAME_ENDED']);
    const victory = result.events[1];
    assert.ok(victory.type === 'VICTORY_DECIDED');
    assert.deepEqual(victory.payload, { winnerIds: ['Ada'], reason: 'NET_WORTH_TARGET' });
    assert.equal(result.state.phase, 'GAME_OVER');
  });

  it('ties at the top of the target share the victory', () => {
    const state = craftedState({
      players: [mkPlayer({ id: 'Ada', seat: 0, cash: 6000 }), mkPlayer({ id: 'Grace', seat: 1, cash: 6100 })],
      owners: { 'foundry-anvil': 'Ada' },
    });
    const result = applyOk(state, 'END_TURN');
    const victory = result.events.find((e): e is Extract<AnyGameEvent, { type: 'VICTORY_DECIDED' }> => e.type === 'VICTORY_DECIDED');
    assert.ok(victory);
    assert.deepEqual(victory.payload, { winnerIds: ['Ada', 'Grace'], reason: 'NET_WORTH_TARGET' });
  });

  it('ROUND_CAP ends the game when a handover wraps past the mode cap; ties share', () => {
    // Blitz caps at 15 rounds. Grace (last seat) ends her turn: the handover
    // wraps to Ada and would start round 16 — the richest players win, and
    // with equal net worth the victory is shared.
    const state = craftedState({
      mode: 'BLITZ',
      round: MODES.BLITZ.roundCap,
      activePlayerId: 'Grace',
      players: [mkPlayer({ id: 'Ada', seat: 0 }), mkPlayer({ id: 'Grace', seat: 1 })],
    });
    assert.equal(state.round, 15);
    const result = applyOk(state, 'END_TURN');
    assert.deepEqual(eventTypes(result.events), ['TURN_ENDED', 'VICTORY_DECIDED', 'GAME_ENDED']);
    const victory = result.events[1];
    assert.ok(victory.type === 'VICTORY_DECIDED');
    assert.deepEqual(victory.payload, { winnerIds: ['Ada', 'Grace'], reason: 'ROUND_CAP' });
    assert.equal(result.state.phase, 'GAME_OVER');
    assert.equal(result.state.round, 15, 'the over-cap round never begins');
  });

  it('the round cap is not triggered before the handover wraps', () => {
    const state = craftedState({
      mode: 'BLITZ',
      round: MODES.BLITZ.roundCap,
      activePlayerId: 'Ada',
      players: [mkPlayer({ id: 'Ada', seat: 0 }), mkPlayer({ id: 'Grace', seat: 1 })],
    });
    const result = applyOk(state, 'END_TURN');
    assert.deepEqual(eventTypes(result.events), ['TURN_ENDED', 'TURN_STARTED']);
    assert.equal(result.state.round, 15, 'Ada\u2019s handover to Grace stays inside the cap');
    assert.equal(result.state.activePlayerId, 'Grace');
  });
});

describe('endgame — schema v2 persistence (spec §2.4)', () => {
  it('bumps the snapshot schema for the waterfall and estate fields', () => {
    assert.equal(SNAPSHOT_SCHEMA_VERSION, 2, 'the waterfall added round + estateSale — old saves must refuse cleanly');
  });
});

// ---------------------------------------------------------------------------
// §17.2 seam replacement at compile time: the bankruptcy vocabulary lives as
// proper endgame event types (the settlement/economy unions stay structurally
// bankruptcy-free — pinned in debt.test.ts). If any of the three ever leaves
// EndgameEventInput, the annotated constant flips to false and fails here.
type WaterfallEventType = 'PLAYER_BANKRUPT' | 'PLAYER_ELIMINATED' | 'ASSETS_TRANSFERRED';
type WaterfallEventsAreEndgame = Extract<EndgameEventInput['type'], WaterfallEventType> extends WaterfallEventType ? true : false;
const waterfallEventsAreEndgame: WaterfallEventsAreEndgame = true;

describe('endgame — §17.2 type contract', () => {
  it('carries the bankruptcy vocabulary as first-class endgame event types', () => {
    assert.equal(waterfallEventsAreEndgame, true, 'PLAYER_BANKRUPT, PLAYER_ELIMINATED and ASSETS_TRANSFERRED must all be EndgameEventInput members');
  });
});
