/**
 * Balance-simulation harness tests (PR 9) — spec §8 and §17.3.
 *
 * Covers: profile catalog and seat rotation, the pure strategy helpers
 * (including the livePlayersAfter wrap-around regression), settlement
 * steps on synthetic states, seed derivation determinism, a full
 * micro-matrix where every game must finish with all four §17.3
 * demonstration assertions green, and rerun determinism (the same cell
 * run twice produces byte-identical summaries).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createGame } from '../../src/lib/game/engine/reducer';
import { BOARD_SPACES, isPurchasable, type ModeId } from '../../src/lib/game/board-v1';
import type { GameState, PlayerId, PlayerState } from '../../src/lib/game/types';
import { BANK_ID } from '../../src/lib/game/types';
import {
  bidTowards,
  livePlayersAfter,
  PROFILE_ROTATION,
  profileForSeat,
  settlementStep,
  strategyFor,
} from '../../tools/sim/profiles';
import { runCell, runMatrix, seedForGame } from '../../tools/sim/matrix';

/** A real lobby state, used as the base for synthetic overrides. */
function baseState(playerIds: readonly string[], mode: ModeId = 'BLITZ'): GameState {
  const result = createGame({ gameId: 'sim-fixture', seed: 0xa110ce, playerIds: playerIds as PlayerId[], mode });
  if (!result.ok) throw result.error;
  return result.state;
}

/** Replace a player's fields; the GameState is readonly so tests rebuild it. */
function withPlayer(state: GameState, playerId: PlayerId, overrides: Partial<PlayerState>): GameState {
  const players = state.players.map((player) => (player.id === playerId ? { ...player, ...overrides } : player));
  return { ...state, players };
}

const firstProperty = BOARD_SPACES.find((space) => isPurchasable(space) && space.kind === 'PROPERTY');
assert.ok(firstProperty, 'board-v1 must contain at least one purchasable property');

describe('profile catalog', () => {
  it('exposes exactly the four §8 profiles in fixed rotation', () => {
    assert.deepEqual([...PROFILE_ROTATION], ['CONSERVATIVE', 'AGGRESSIVE', 'MIXED', 'RANDOM_WALK']);
  });

  it('maps seats in fixed rotation CONSERVATIVE → AGGRESSIVE → MIXED → RANDOM_WALK', () => {
    assert.equal(profileForSeat(0), 'CONSERVATIVE');
    assert.equal(profileForSeat(1), 'AGGRESSIVE');
    assert.equal(profileForSeat(2), 'MIXED');
    assert.equal(profileForSeat(3), 'RANDOM_WALK');
    assert.equal(profileForSeat(4), 'CONSERVATIVE', 'seat 5 wraps to the rotation start');
  });

  it('gives every profile a complete strategy object', () => {
    for (const id of PROFILE_ROTATION) {
      const strategy = strategyFor(id);
      assert.equal(typeof strategy.decideRoll, 'function', `${id}.decideRoll`);
      assert.equal(typeof strategy.decideBuy, 'function', `${id}.decideBuy`);
      assert.equal(typeof strategy.decideBid, 'function', `${id}.decideBid`);
      assert.equal(typeof strategy.decideManagement, 'function', `${id}.decideManagement`);
      assert.equal(typeof strategy.decideAnswer, 'function', `${id}.decideAnswer`);
      assert.equal(typeof strategy.decideSettlement, 'function', `${id}.decideSettlement`);
    }
  });
});

describe('livePlayersAfter', () => {
  it('never includes the actor (wrap-around regression: §17.3 self-trade)', () => {
    const state = baseState(['p1', 'p2']);
    const after = livePlayersAfter(state, 'p1');
    assert.ok(!after.includes('p1'), 'the actor must never be their own trade recipient');
    assert.deepEqual(after, ['p2']);
  });

  it('orders seats after the actor and skips eliminated players', () => {
    const eliminated = withPlayer(baseState(['p1', 'p2', 'p3']), 'p2', { eliminated: true });
    assert.deepEqual(livePlayersAfter(eliminated, 'p1'), ['p3']);
    assert.deepEqual(livePlayersAfter(eliminated, 'p3'), ['p1']);
  });
});

describe('bidTowards (cash-backed auction policy)', () => {
  it('opens at exactly $10 when the ceiling allows', () => {
    assert.deepEqual(bidTowards({ cash: 500, currentBid: null, ceiling: 100 }), { action: 'BID', amount: 10 });
  });

  it('raises by exactly one $10 increment under the ceiling', () => {
    assert.deepEqual(bidTowards({ cash: 500, currentBid: 60, ceiling: 100 }), { action: 'BID', amount: 70 });
  });

  it('passes when the next increment exceeds the ceiling', () => {
    assert.deepEqual(bidTowards({ cash: 500, currentBid: 100, ceiling: 100 }), { action: 'PASS_BID' });
  });

  it('passes when cash cannot back even the $10 opening (spec §5)', () => {
    assert.deepEqual(bidTowards({ cash: 5, currentBid: null, ceiling: 100 }), { action: 'PASS_BID' });
    assert.deepEqual(bidTowards({ cash: 5, currentBid: 20, ceiling: 100 }), { action: 'PASS_BID' });
  });
});

describe('settlementStep (§7 liquidation ladder)', () => {
  const debt = { debtorId: 'p1' as PlayerId, creditorId: BANK_ID, amountDue: 300, reason: 'TAX' as const };

  it('settles when cash already covers the debt', () => {
    const state = withPlayer(baseState(['p1', 'p2']), 'p1', { cash: 300 });
    assert.deepEqual(settlementStep({ ...state, debt }, 'p1'), { action: 'SETTLE_DEBT' });
  });

  it('sells an upgrade first when levels exist', () => {
    const state = {
      ...withPlayer(baseState(['p1', 'p2']), 'p1', { cash: 100 }),
      owners: { [firstProperty.id]: 'p1' as PlayerId },
      upgrades: { [firstProperty.id]: 2 },
      debt,
    };
    assert.deepEqual(settlementStep(state, 'p1'), { action: 'SELL_UPGRADE', spaceId: firstProperty.id });
  });

  it('mortgages an unmortgaged level-0 holding next', () => {
    const state = {
      ...withPlayer(baseState(['p1', 'p2']), 'p1', { cash: 100 }),
      owners: { [firstProperty.id]: 'p1' as PlayerId },
      debt,
    };
    assert.deepEqual(settlementStep(state, 'p1'), { action: 'MORTGAGE', spaceId: firstProperty.id });
  });

  it('surrenders when nothing can be liquidated', () => {
    const broke = withPlayer(baseState(['p1', 'p2']), 'p1', { cash: 100 });
    assert.deepEqual(settlementStep({ ...broke, debt }, 'p1'), { action: 'SURRENDER' });
  });
});

describe('seedForGame', () => {
  it('is deterministic in (mode, playerCount, gameIndex)', () => {
    for (const mode of ['CLASSIC', 'QUICK', 'BLITZ'] as const) {
      for (const players of [2, 3, 4, 6]) {
        for (let index = 0; index < 5; index++) {
          assert.equal(seedForGame(mode, players, index), seedForGame(mode, players, index));
        }
      }
    }
  });

  it('stays inside the 32-bit seed space', () => {
    const seed = seedForGame('CLASSIC', 2, 0);
    assert.ok(Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff);
  });

  it('differs across game indices, modes, and player counts (spot check)', () => {
    assert.notEqual(seedForGame('CLASSIC', 2, 0), seedForGame('CLASSIC', 2, 1));
    assert.notEqual(seedForGame('CLASSIC', 2, 0), seedForGame('QUICK', 2, 0));
    assert.notEqual(seedForGame('CLASSIC', 2, 0), seedForGame('CLASSIC', 3, 0));
  });
});

describe('micro-matrix (1 seed × all 12 cells) — §17.3 all green', () => {
  let result: Awaited<ReturnType<typeof runMatrix>>;

  it('completes every cell with all four demonstration assertions green', async () => {
    result = await runMatrix({ seedCount: 1 });
    assert.equal(result.cells.length, 12);
    for (const cell of result.cells) {
      const label = `${cell.mode} ${cell.playerCount}p`;
      assert.equal(cell.demonstration.games, 1, `${label}: one game`);
      assert.equal(cell.demonstration.replayVerified, 1, `${label}: (d) replay identical`);
      assert.equal(cell.demonstration.allGreen, 1, `${label}: all four assertions green`);
      // Probes fire at every roll decision point, so rejection counts grow
      // with game length; the contract requires at least one of each.
      assert.ok(cell.demonstration.unauthorizedActorRejections >= 1, `${label}: (a) unauthorized actor rejected`);
      assert.ok(cell.demonstration.staleVersionRejections >= 1, `${label}: (b) stale version rejected`);
      assert.ok(cell.demonstration.idempotentReplays >= 1, `${label}: (c) duplicate commandId applied exactly once`);
    }
  });

  it('reports coherent metrics', () => {
    for (const cell of result.cells) {
      const label = `${cell.mode} ${cell.playerCount}p`;
      const endedTotal = Object.values(cell.endedBy).reduce((a: number, b: number) => a + b, 0);
      assert.equal(endedTotal, cell.seedCount, `${label}: every game has an ending`);
      assert.ok(cell.appliedCommands.p50 <= cell.appliedCommands.p90, `${label}: p50 commands ≤ p90`);
      assert.ok(cell.rounds.p50 <= cell.rounds.p90, `${label}: p50 rounds ≤ p90`);
      assert.ok(cell.bankruptciesPerGame >= 0 && cell.meanPropertiesAcquiredPerPlayer >= 0, `${label}: sane totals`);
    }
  });
});

describe('rerun determinism (report regeneration contract)', () => {
  it('produces byte-identical cell summaries across two runs', async () => {
    const first = await runCell('BLITZ', 2, 3);
    const second = await runCell('BLITZ', 2, 3);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
  });
});
