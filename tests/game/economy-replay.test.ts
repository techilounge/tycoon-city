import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BOARD_SPACES, EVENT_DECK_CATALOG, type EventCard } from '../../src/lib/game/board-v1';
import type { CommandType, GameCommand } from '../../src/lib/game/commands';
import type { AnyGameEvent } from '../../src/lib/game/events';
import { isDebtHopeless } from '../../src/lib/game/engine/debt';
import { applyCommand } from '../../src/lib/game/engine/reducer';
import { replayCommands, stateHash } from '../../src/lib/game/engine/replay';
import { rngForState } from '../../src/lib/game/rng';
import { RULES_VERSION, type GameState, type PlayerId, type PlayerState } from '../../src/lib/game/types';

// ---------------------------------------------------------------------------
// Helpers (per-file copies of the established pattern)

let commandSeq = 0;
function makeCommand(state: GameState, type: CommandType, opts: { actor?: PlayerId; payload?: Record<string, unknown> } = {}): GameCommand {
  return {
    commandId: `cmd-${++commandSeq}`,
    gameId: state.gameId,
    actorId: opts.actor ?? state.activePlayerId ?? state.players[0].id,
    expectedVersion: state.version,
    type,
    payload: opts.payload ?? {},
  } as GameCommand;
}

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

function eventTypes(events: readonly AnyGameEvent[]): string[] {
  return events.map((e) => e.type);
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

/** A mid-game economy session: Ada is settling a $150 rent debt to Grace,
 *  holding Anvil & Ore Works at level 2. Deck half-drawn. This state walks
 *  the driver through the whole transitional settlement surface. */
function economySessionState(): GameState {
  return {
    gameId: 'g-econ-replay',
    version: 7,
    phase: 'PLAYING',
    turnPhase: 'SETTLING_DEBT',
    mode: 'CLASSIC',
    doublesCount: 0,
    owners: { 'foundry-anvil': 'Ada', 'harbor-saltmarket': 'Grace', 'midtown-exchange': 'Grace' },
    upgrades: { 'foundry-anvil': 2 },
    mortgaged: {},
    eventDeck: {
      drawPile: ['municipal-fine', 'dividend-disbursement', 'transit-day-pass', 'parade-blocks-line'],
      discardPile: ['storm-repairs', 'zoning-variance'],
    },
    debt: { debtorId: 'Ada', creditorId: 'Grace', amountDue: 150, reason: 'RENT' },
    auction: null,
    trade: null,
    estateSale: null,
    rulesVersion: RULES_VERSION,
    seed: 4242,
    rngState: 4242,
    players: [
      mkPlayer({ id: 'Ada', seat: 0, position: 9, cash: 80 }),
      mkPlayer({ id: 'Grace', seat: 1, position: 14, cash: 900 }),
      mkPlayer({ id: 'Malo', seat: 2, position: 22, cash: 1400 }),
    ],
    activePlayerId: 'Ada',
    turn: 5,
    round: 1,
    lastEventSequence: 40,
    processedCommandIds: [],
  } as GameState;
}

interface DriveResult {
  state: GameState;
  log: readonly GameCommand[];
  events: readonly AnyGameEvent[];
  pausedHopeless: boolean;
}

/** Deterministic generic driver: from any phase, choose the legal command a
 *  simple strategy would, collecting the applied log. Choices depend only on
 *  state, so identical initial states drive identical sessions. */
function driveEconomySession(initial: GameState, maxCommands: number): DriveResult {
  commandSeq = 0; // deterministic ids per drive — they live in the state hash
  let state = initial;
  const log: GameCommand[] = [];
  const events: AnyGameEvent[] = [];

  const push = (type: CommandType, opts: { payload?: Record<string, unknown>; actor?: PlayerId } = {}): void => {
    const command = makeCommand(state, type, opts);
    const result = applyCommand(state, command, rngForState(state.rngState));
    assert.ok(result.ok, `${type} must apply in the driven session: ${result.ok ? '' : result.error.message}`);
    if (result.ok && result.applied) {
      log.push(command);
      events.push(...result.events);
      state = result.state;
    }
  };

  while (log.length < maxCommands) {
    if (state.phase === 'GAME_OVER') break;
    switch (state.turnPhase) {
      case 'AWAITING_ROLL':
        push('ROLL');
        break;
      case 'BUY_DECISION': {
        const actor = state.players.find((p) => p.id === state.activePlayerId);
        assert.ok(actor);
        const landed = BOARD_SPACES[actor.position];
        // BUY_DECISION is only reachable for an unowned purchasable space, so
        // the price guard is always satisfiable here; PASS_TO_AUCTION is the
        // defensive fallback (unimplemented until PR 6).
        if ('listPrice' in landed && actor.cash >= landed.listPrice) push('BUY', { payload: { spaceId: landed.id } });
        else push('PASS_TO_AUCTION');
        break;
      }
      case 'AUCTION': {
        // Real auctions since PR 6: the driver never bids — the first player
        // unpassed and not the high bidder passes, deterministically; a
        // no-bid auction ends unsold once everyone has passed.
        const auction = state.auction;
        if (!auction) throw new Error('engine bug: AUCTION phase without an open auction');
        const bidder = auction.eligiblePlayerIds.find(
          (id) => !auction.passedPlayerIds.includes(id) && auction.highBidderId !== id,
        );
        if (!bidder) throw new Error('engine bug: no actionable bidder in an open auction');
        push('PASS_BID', { actor: bidder, payload: { auctionId: auction.auctionId } });
        break;
      }
      case 'TURN_MANAGEMENT':
        push('END_TURN');
        break;
      case 'SETTLING_DEBT': {
        const debt = state.debt;
        if (!debt) throw new Error('engine bug: SETTLING_DEBT without an open debt');
        if (isDebtHopeless(state, debt)) {
          // The pause is correct transitional behavior (spec §17.2) — stop
          // driving here; the replay assertions cover the log so far.
          return { state, log, events, pausedHopeless: true };
        }
        const debtor = state.players.find((p) => p.id === debt.debtorId);
        assert.ok(debtor);
        if (debtor.cash >= debt.amountDue) {
          push('SETTLE_DEBT');
          // End the session at the settle + turn handoff: an open-ended drive
          // eventually reaches a SECOND debt that is legitimately hopeless
          // (the transitional pause), which is PR 8's seam, not this test's.
          push('END_TURN');
          return { state, log, events, pausedHopeless: false };
        } else {
          const owned = Object.entries(state.owners)
            .filter(([, owner]) => owner === debtor.id)
            .map(([spaceId]) => spaceId);
          const withLevels = owned.find((spaceId) => (state.upgrades[spaceId] ?? 0) > 0);
          const unmortgaged = owned.find((spaceId) => !state.mortgaged[spaceId]);
          if (withLevels) push('SELL_UPGRADE', { payload: { spaceId: withLevels } });
          else if (unmortgaged) push('MORTGAGE', { payload: { spaceId: unmortgaged } });
          else throw new Error('driver bug: settleable debt but no liquidation found');
        }
        break;
      }
      default:
        return { state, log, events, pausedHopeless: false };
    }
  }
  return { state, log, events, pausedHopeless: false };
}

// ---------------------------------------------------------------------------
// Replay and determinism over an economy-rich session

describe('economy session replay (spec §2.3, §12)', () => {
  it('drives a full liquidate-settle-roll session through every settlement path', () => {
    const initial = economySessionState();
    const run = driveEconomySession(initial, 30);

    // The driven session must have exercised the transitional settlement
    // surface: level sell-back, mortgage, atomic settle, then further play.
    const types = eventTypes(run.events);
    assert.equal(types.includes('UPGRADE_SOLD'), true, 'a level sell-back must occur');
    assert.equal(types.includes('MORTGAGE_TAKEN'), true, 'a mortgage must occur');
    assert.equal(types.includes('DEBT_SETTLED'), true, 'the debt must settle');
    assert.equal(run.pausedHopeless, false);
    assert.equal(run.state.debt, null);
    assert.equal(run.state.turnPhase, 'AWAITING_ROLL', 'the turn hands off after the settle');
    assert.ok(run.log.length >= 5, `the session must span the settle flow, saw ${run.log.length}`);
  });

  it('refolds the applied log into an identical state hash', () => {
    const initial = economySessionState();
    const run = driveEconomySession(initial, 30);
    const replayed = replayCommands(initial, run.log);
    assert.equal(stateHash(replayed.state), stateHash(run.state));
    assert.deepEqual(eventTypes(replayed.events), eventTypes(run.events), 'the replayed event stream matches the live fold');
  });

  it('is deterministic — two identical drives produce identical hashes', () => {
    const a = driveEconomySession(economySessionState(), 30);
    const b = driveEconomySession(economySessionState(), 30);
    assert.equal(stateHash(a.state), stateHash(b.state));
    assert.deepEqual(a.log.map((c) => c.commandId), b.log.map((c) => c.commandId));
  });

  it('resubmitting the applied log applies nothing (idempotent ledger)', () => {
    const initial = economySessionState();
    const run = driveEconomySession(initial, 30);
    for (const command of run.log) {
      const result = applyCommand(run.state, command, rngForState(run.state.rngState));
      assert.ok(result.ok, `resubmission of ${command.type} must succeed idempotently`);
      if (result.ok) {
        assert.equal(result.applied, false, `${command.commandId} must apply exactly once`);
        assert.deepEqual(result.events, []);
      }
    }
  });

  it('the whole session stream never contains a bankruptcy event', () => {
    const run = driveEconomySession(economySessionState(), 30);
    const banned: readonly string[] = ['PLAYER_BANKRUPT', 'PLAYER_ELIMINATED', 'ASSETS_TRANSFERRED'];
    for (const type of eventTypes(run.events)) {
      assert.equal(banned.includes(type), false, `${type} must never be emitted by this build`);
    }
  });
});

// ---------------------------------------------------------------------------
// Per-card sweep — every catalog card draws and applies its exact effect

describe('event deck: all 18 catalog cards', () => {
  const ALL_IDS = EVENT_DECK_CATALOG.map((card) => card.id);
  const SEED_SUM2 = findSeed(500, (seed) => {
    const [a, b] = firstRoll(seed);
    return a + b === 2;
  });

  function deckState(card: EventCard): GameState {
    return {
      gameId: 'g-cards',
      version: 7,
      phase: 'PLAYING',
      turnPhase: 'AWAITING_ROLL',
      mode: 'CLASSIC',
      doublesCount: 0,
      owners: {},
      upgrades: {},
      mortgaged: {},
      eventDeck: {
        drawPile: [card.id, ...ALL_IDS.filter((id) => id !== card.id)],
        discardPile: [],
      },
      debt: null,
      auction: null,
      trade: null,
      estateSale: null,
      rulesVersion: RULES_VERSION,
      seed: SEED_SUM2,
      rngState: SEED_SUM2,
      players: [mkPlayer({ id: 'Ada', seat: 0, position: 0 }), mkPlayer({ id: 'Grace', seat: 1, position: 12 })],
      activePlayerId: 'Ada',
      turn: 2,
      round: 1,
      lastEventSequence: 9,
      processedCommandIds: [],
    } as GameState;
  }

  for (const card of EVENT_DECK_CATALOG) {
    it(`card ${card.id} draws with its id in meta and applies its catalog effect`, () => {
      const state = deckState(card);
      const result = applyCommand(state, makeCommand(state, 'ROLL'), rngForState(state.rngState));
      assert.ok(result.ok, `ROLL must apply for ${card.id}`);
      if (!result.ok) throw new Error('unreachable');

      const types = eventTypes(result.events);
      assert.equal(types.includes('CARD_DRAWN'), true, `${card.id} must draw`);
      assert.equal(types.includes('CARD_EFFECT_APPLIED'), true, `${card.id} must apply`);

      const drawn = result.events.find((e) => e.type === 'CARD_DRAWN');
      assert.ok(drawn && drawn.type === 'CARD_DRAWN');
      assert.equal(drawn.meta.cardId, card.id);

      const applied = result.events.find((e) => e.type === 'CARD_EFFECT_APPLIED');
      assert.ok(applied && applied.type === 'CARD_EFFECT_APPLIED');
      assert.equal(applied.payload.cardId, card.id);
      assert.deepEqual(applied.payload.effect, card.effect);

      // The drawn card moves to the discard pile (ordinary state).
      assert.equal(result.state.eventDeck.discardPile.includes(card.id), true);
    });
  }

  it('exactly 18 cards exist in the catalog', () => {
    assert.equal(EVENT_DECK_CATALOG.length, 18);
  });
});
