/**
 * Server-enforced deadlines (spec "Deadlines — timers that act like players",
 * criterion 7): per-mode windows, the three expiry paths, and the race
 * semantics of server timers competing with player commands.
 *
 * Layers, in increasing integration:
 *   A  pure composition — phase → ordinary command, actor stamping, null drops
 *   B  DeadlineScheduler with fake timers — window arming, full fresh windows
 *      on re-arm, stop
 *   C  GameHost integration — deadlines applied through the real submit path
 *      into SQLite (ledgered `server-auto-…` commands), the race matrix, and
 *      re-arm after a restart resume
 *   D  gateway wiring — the `game:deadline` broadcast on create/join
 *
 * Fake timers: node:test mock.timers over setTimeout only — real Date is
 * kept (broadcast timestamps are informational), and tickAsync flushes the
 * queue's promise chain after each advance.
 */
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { after, before, describe, it } from 'node:test';
import fs from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Server as SocketIoServer } from 'socket.io';
import type { CommandType, GameCommand } from '../../src/lib/game/commands';
import { applyCommand } from '../../src/lib/game/engine/reducer';
import { rngForState } from '../../src/lib/game/rng';
import { BANK_ID, RULES_VERSION, type GameState, type PlayerId, type PlayerState } from '../../src/lib/game/types';
import { TycoonDb } from '../../server/db';
import { GameHost } from '../../server/game/gameHost';
import {
  DeadlineScheduler,
  DEFAULT_DEADLINE_POLICY,
  auctionExpirySubmission,
  turnExpirySubmission,
  type DeadlinePolicy,
  type DeadlineSubmission,
} from '../../server/game/deadlines';
import { startHarness, type TestHarness } from './helpers';

// ---------------------------------------------------------------------------
// Shared fixtures (per-file copies of the established pattern)

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

function applyOk(state: GameState, type: CommandType, opts: { actor?: PlayerId; payload?: Record<string, unknown> } = {}): GameState {
  const result = applyCommand(state, makeCommand(state, type, opts), rngForState(state.rngState));
  assert.ok(result.ok, `${type} must apply: ${result.ok ? '' : result.error.message}`);
  if (!result.ok) throw new Error('unreachable');
  return result.state;
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

function craftedState(overrides: {
  players?: PlayerState[];
  activePlayerId?: PlayerId | null;
  turnPhase?: GameState['turnPhase'];
} = {}): GameState {
  return {
    gameId: 'g-comp',
    version: 7,
    phase: 'PLAYING',
    turnPhase: overrides.turnPhase ?? 'AWAITING_ROLL',
    mode: 'CLASSIC',
    doublesCount: 0,
    owners: {},
    upgrades: {},
    mortgaged: {},
    eventDeck: { drawPile: [], discardPile: [] },
    debt: null,
    auction: null,
    trade: null,
    estateSale: null,
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

/** An open auction on Ada's token space, produced by the real row-6 handler. */
function openAuction(players?: PlayerState[]): { state: GameState; auctionId: string } {
  const base = craftedState({
    players: players ?? [mkPlayer({ id: 'Ada', seat: 0, position: 1 }), mkPlayer({ id: 'Grace', seat: 1 })],
    turnPhase: 'BUY_DECISION',
  });
  const s1 = applyOk(base, 'PASS_TO_AUCTION');
  const auction = s1.auction;
  assert.ok(auction);
  return { state: s1, auctionId: auction.auctionId };
}

function autoCommandsOf(db: TycoonDb, gameId: string): GameCommand[] {
  return db.listAppliedCommands(gameId).filter((c) => c.commandId.startsWith('server-auto-'));
}

type Tick = (ms: number) => Promise<unknown>;

/** This Node's mock timers lack tickAsync — advance the mocked clock, then
 *  flush the queue's promise chain with unmocked setImmediate rounds. */
async function tickAndFlush(t: TestContext, ms: number): Promise<void> {
  t.mock.timers.tick(ms);
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------
// A — pure composition

describe('deadline composition (pure)', () => {
  it('maps each turn decision phase to its ordinary command, stamped with the expired player', () => {
    const expected: ReadonlyArray<[GameState['turnPhase'], CommandType]> = [
      ['AWAITING_ROLL', 'ROLL'],
      ['BUY_DECISION', 'PASS_TO_AUCTION'],
      ['SETTLING_DEBT', 'SURRENDER'],
      ['TURN_MANAGEMENT', 'END_TURN'],
    ];
    for (const [turnPhase, type] of expected) {
      const state = craftedState({ turnPhase });
      const submission = turnExpirySubmission(state, 'sv-x');
      assert.ok(submission, `${turnPhase} must compose`);
      assert.equal(submission.command.type, type);
      assert.equal(submission.command.actorId, 'Ada', 'the expired active player acts');
      assert.equal(submission.session.actorId, 'Ada');
      assert.equal(submission.command.expectedVersion, state.version);
      assert.equal(submission.command.gameId, state.gameId);
    }
  });

  it('drops non-decision phases, lobby, game over, and headless states', () => {
    for (const turnPhase of ['RESOLVING_MOVE', 'AUCTION', 'ELIMINATION_AUCTIONS'] as const) {
      assert.equal(turnExpirySubmission(craftedState({ turnPhase }), 'sv-x'), null, turnPhase);
    }
    const lobby = { ...craftedState(), phase: 'LOBBY' as const };
    assert.equal(turnExpirySubmission(lobby, 'sv-x'), null);
    const over = { ...craftedState(), phase: 'GAME_OVER' as const };
    assert.equal(turnExpirySubmission(over, 'sv-x'), null);
    assert.equal(turnExpirySubmission(craftedState({ activePlayerId: null }), 'sv-x'), null);
  });

  it('a standing bid expires as the bank voiding that auction', () => {
    const opened = openAuction();
    const state = applyOk(opened.state, 'BID', { actor: 'Grace', payload: { auctionId: opened.auctionId, amount: 100 } });
    const submission = auctionExpirySubmission(state, 'sv-x');
    assert.ok(submission);
    assert.equal(submission.command.type, 'VOID_BID');
    assert.equal(submission.command.actorId, BANK_ID, 'the server identity acts');
    assert.equal(submission.session.actorId, BANK_ID);
    assert.deepEqual(submission.command.payload, { auctionId: opened.auctionId });
  });

  it('no standing bid expires as a binding pass for the first eligible unpassed bidder', () => {
    const { state, auctionId } = openAuction();
    const submission = auctionExpirySubmission(state, 'sv-x');
    assert.ok(submission);
    assert.equal(submission.command.type, 'PASS_BID');
    // Eligibility is by seat order, and the decliner of the buy decision
    // remains eligible to bid in the auction — so Ada passes first.
    assert.equal(submission.command.actorId, 'Ada', 'the first eligible unpassed bidder');
    assert.deepEqual(submission.command.payload, { auctionId });
  });

  it('keeps composing passes until the sale closes, then drops', () => {
    assert.equal(auctionExpirySubmission(craftedState(), 'sv-x'), null, 'no open auction');
    const { state, auctionId } = openAuction();
    const gracePassed = applyOk(state, 'PASS_BID', { actor: 'Grace', payload: { auctionId } });
    const next = auctionExpirySubmission(gracePassed, 'sv-y');
    assert.ok(next, 'the auction is still open with one unpassed bidder');
    assert.equal(next.command.type, 'PASS_BID');
    assert.equal(next.command.actorId, 'Ada');
    const closed = applyOk(gracePassed, 'PASS_BID', { actor: 'Ada', payload: { auctionId } });
    assert.equal(closed.auction, null, 'two passes in a two-seat auction close the sale unsold');
    assert.equal(auctionExpirySubmission(closed, 'sv-z'), null, 'closed — nothing left to compose');
  });
});

// ---------------------------------------------------------------------------
// B — the scheduler under fake timers

const SHORT_POLICY: DeadlinePolicy = { turnMs: { CLASSIC: 50, QUICK: 50, BLITZ: 50 }, auctionBidMs: 30 };

describe('DeadlineScheduler windows (fake timers)', () => {
  it('fires the turn window once at expiry with the submission composed from the current state', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const state = craftedState({ turnPhase: 'AWAITING_ROLL' });
    const seen: DeadlineSubmission[] = [];
    const scheduler = new DeadlineScheduler(async (compose) => {
      const submission = compose(state);
      if (submission !== null) seen.push(submission);
    }, SHORT_POLICY);
    scheduler.sync(state);

    await tickAndFlush(t, 49);
    assert.equal(seen.length, 0, 'silent inside the window');
    await tickAndFlush(t, 1);
    assert.equal(seen.length, 1, 'fires at the window');
    assert.equal(seen[0].command.type, 'ROLL');
    scheduler.stop();
    await tickAndFlush(t, 500);
    assert.equal(seen.length, 1, 'one-shot: no refire');
  });

  it('a re-arm grants a full fresh window — a partial window is not inherited', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let state = craftedState({ turnPhase: 'AWAITING_ROLL' });
    const seen: DeadlineSubmission[] = [];
    const scheduler = new DeadlineScheduler(async (compose) => {
      const submission = compose(state);
      if (submission !== null) seen.push(submission);
    }, SHORT_POLICY);
    scheduler.sync(state);
    await tickAndFlush(t, 25);

    // A player acted: the new state re-arms the window from zero.
    state = { ...state, version: state.version + 1 };
    scheduler.sync(state);
    await tickAndFlush(t, 26);
    assert.equal(seen.length, 0, '25+26 < 50 from the re-arm — the stale timer is gone and the new one is young');
    await tickAndFlush(t, 24);
    assert.equal(seen.length, 1, 'fires 50ms after the re-arm');
    scheduler.stop();
  });

  it('the auction window is independent and maps to the auction composition', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { state } = openAuction(); // turnPhase AUCTION, no standing bid
    const seen: DeadlineSubmission[] = [];
    const scheduler = new DeadlineScheduler(async (compose) => {
      const submission = compose(state);
      if (submission !== null) seen.push(submission);
    }, SHORT_POLICY);
    scheduler.sync(state);
    await tickAndFlush(t, 29);
    assert.equal(seen.length, 0, 'the turn window is not armed during an auction, and the auction window is silent');
    await tickAndFlush(t, 1);
    assert.equal(seen.length, 1, 'the auction window fired at its own 30ms');
    assert.equal(seen[0].command.type, 'PASS_BID');
    scheduler.stop();
  });

  it('arms nothing in the lobby or after game over', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const seen: DeadlineSubmission[] = [];
    const scheduler = new DeadlineScheduler(async (compose) => {
      const submission = compose(craftedState());
      if (submission !== null) seen.push(submission);
    }, SHORT_POLICY);
    scheduler.sync({ ...craftedState(), phase: 'LOBBY' });
    scheduler.sync({ ...craftedState(), phase: 'GAME_OVER' });
    await tickAndFlush(t, 10_000);
    assert.equal(seen.length, 0);
    scheduler.stop();
  });
});

// ---------------------------------------------------------------------------
// C — GameHost integration: deadlines through the real submit path

describe('GameHost deadlines (SQLite + fake timers)', () => {
  let db: TycoonDb;
  let io: SocketIoServer;
  let httpServer: HttpServer;
  let dir: string;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-deadlines-'));
    db = TycoonDb.open(path.join(dir, 'deadlines.db'));
    // Bare http server with a fallback handler BEFORE socket.io attaches —
    // the gateway.test.ts pattern (a bare SocketIoServer without one breaks
    // io.close()).
    httpServer = createServer((_req, res) => {
      res.statusCode = 404;
      res.end('not found');
    });
    io = new SocketIoServer(httpServer);
  });

  after(() => {
    io.close();
    httpServer.close();
    db.close();
  });

  function makeHost(gameId: string): GameHost {
    const { host } = GameHost.create(db, io, {
      mode: 'CLASSIC',
      playerIds: ['Ada', 'Grace'],
      gameId,
      seed: 7,
      deadlinePolicy: SHORT_POLICY,
    });
    return host;
  }

  async function startGame(host: GameHost, gameId: string): Promise<void> {
    const result = await host.submit({ gameId, actorId: 'Ada' }, {
      commandId: 'start-1',
      gameId,
      actorId: 'Ada',
      expectedVersion: host.clientState.version,
      type: 'START_GAME',
      payload: {},
    });
    assert.ok(result.ok, `START_GAME must apply: ${result.ok ? '' : JSON.stringify(result.error)}`);
  }

  /** Drive with turn expiries until the wanted turn phase is reached. The
   *  expiries ARE the driver — each tick advances the game — so whoever is
   *  active when the phase arrives depends on the seeded flow. */
  async function driveToPhase(host: GameHost, wanted: GameState['turnPhase'], tick: Tick, maxTicks = 12): Promise<void> {
    for (let i = 0; i < maxTicks; i++) {
      if (host.clientState.turnPhase === wanted) return;
      await tick(50);
    }
    assert.equal(host.clientState.turnPhase, wanted, `did not reach ${wanted} within ${maxTicks} expiries`);
  }

  it('criterion 7a — PLAYING expiry auto-rolls for the expired player, ledgered as a server command', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const tick: Tick = (ms) => tickAndFlush(t, ms);
    const gameId = 'g-dl-roll';
    const host = makeHost(gameId);
    try {
      await startGame(host, gameId);
      assert.notEqual(host.deadlineBroadcast.turnExpiresAtMs, null, 'the turn window is armed after the start');

      await tick(50);

      const auto = autoCommandsOf(db, gameId);
      assert.equal(auto.length, 1, 'exactly one server command');
      assert.equal(auto[0].type, 'ROLL');
      assert.equal(auto[0].actorId, 'Ada', 'the expired active player');
      assert.ok(auto[0].commandId.startsWith('server-auto-'));
      // The roll resolved the move atomically: a buy decision or turn management is pending.
      assert.ok(
        host.clientState.turnPhase === 'BUY_DECISION' || host.clientState.turnPhase === 'TURN_MANAGEMENT',
        `post-expiry phase: ${host.clientState.turnPhase}`,
      );
    } finally {
      host.dispose();
    }
  });

  it('criterion 7b — BUY_DECISION expiry auto-declines and the AUCTION window arms', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const tick: Tick = (ms) => tickAndFlush(t, ms);
    const gameId = 'g-dl-buy';
    const host = makeHost(gameId);
    try {
      await startGame(host, gameId);
      await driveToPhase(host, 'BUY_DECISION', tick);
      const decider = host.clientState.activePlayerId;
      await tick(50); // the buy decision expires

      const auto = autoCommandsOf(db, gameId);
      const last = auto[auto.length - 1];
      assert.equal(last.type, 'PASS_TO_AUCTION');
      assert.equal(last.actorId, decider, 'the expired decider declines');
      assert.equal(host.clientState.turnPhase, 'AUCTION');
      assert.ok(host.clientState.auction, 'the auction opened');
      assert.equal(host.deadlineBroadcast.turnExpiresAtMs, null, 'the turn window stands down during an auction');
      assert.notEqual(host.deadlineBroadcast.auctionExpiresAtMs, null, 'the auction window is armed');
    } finally {
      host.dispose();
    }
  });

  it('criterion 7c — a standing bid expires as the bank VOID_BID through the host', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const tick: Tick = (ms) => tickAndFlush(t, ms);
    const gameId = 'g-dl-void';
    const host = makeHost(gameId);
    try {
      await startGame(host, gameId);
      await driveToPhase(host, 'BUY_DECISION', tick);
      await tick(50); // decline → AUCTION

      const auction = host.clientState.auction;
      assert.ok(auction);
      const bid = await host.submit({ gameId, actorId: 'Grace' }, {
        commandId: 'manual-bid-1',
        gameId,
        actorId: 'Grace',
        expectedVersion: host.clientState.version,
        type: 'BID',
        payload: { auctionId: auction.auctionId, amount: 100 },
      });
      assert.ok(bid.ok, `BID must apply: ${bid.ok ? '' : JSON.stringify(bid.error)}`);

      await tick(30); // the bid window expires

      const auto = autoCommandsOf(db, gameId);
      const voidCmd = auto.find((c) => c.type === 'VOID_BID');
      assert.ok(voidCmd, 'the void is ledgered');
      assert.equal(voidCmd.actorId, BANK_ID);
      assert.ok(voidCmd.commandId.startsWith('server-auto-'));
      const voidedEvent = db.getEvents(gameId, 1).find((e) => e.type === 'AUCTION_BID_VOIDED');
      assert.ok(voidedEvent, 'AUCTION_BID_VOIDED in the event log');
      assert.deepEqual((voidedEvent as { payload: unknown }).payload, { auctionId: auction.auctionId, bidderId: 'Grace', amount: 100 });
      const after = host.clientState.auction;
      assert.ok(after, 'the auction continues');
      assert.ok(after.passedPlayerIds.includes('Grace'), 'the voided bidder is out');
      assert.equal(after.highBidderId, null, 'no standing bid remains');
    } finally {
      host.dispose();
    }
  });

  it('criterion 7c — an expired bidless auction passes players bindingly until the sale closes unsold', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const tick: Tick = (ms) => tickAndFlush(t, ms);
    const gameId = 'g-dl-unsold';
    const host = makeHost(gameId);
    try {
      await startGame(host, gameId);
      await driveToPhase(host, 'BUY_DECISION', tick);
      await tick(50); // decline → AUCTION with no standing bid

      // Two seats: each expiry composes one binding pass — the first expiry
      // passes the first eligible bidder, the second closes the sale unsold
      // via the existing end path, and the decliner's turn resumes in
      // management.
      await tick(30);
      const firstPasses = autoCommandsOf(db, gameId).filter((c) => c.type === 'PASS_BID');
      assert.equal(firstPasses.length, 1, 'the first expiry passed one bidder');
      assert.notEqual(host.clientState.auction, null, 'one pass in a two-seat auction keeps the sale open');

      await tick(30);
      assert.equal(host.clientState.auction, null, 'closed unsold');
      assert.equal(autoCommandsOf(db, gameId).filter((c) => c.type === 'PASS_BID').length, 2);
      const closed = db.getEvents(gameId, 1).find((e) => e.type === 'AUCTION_CLOSED_UNSOLD');
      assert.ok(closed, 'the existing unsold-close event fired');
    } finally {
      host.dispose();
    }
  });

  it('criterion 7 — race: the deadline wins the queue over a later player command (stale version rejected)', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const tick: Tick = (ms) => tickAndFlush(t, ms);
    const gameId = 'g-dl-race-a';
    const host = makeHost(gameId);
    try {
      await startGame(host, gameId);
      const versionAtStart = host.clientState.version;

      // Block the queue; let the timer fire and queue behind it; then the
      // player's command queues behind the deadline task.
      let release!: () => void;
      const blocker = host.runExclusive(() => new Promise<void>((resolve) => { release = resolve; }));
      await tick(50); // expiry queued (its composition waits on the blocker)
      const playerRoll = host.submit({ gameId, actorId: 'Ada' }, {
        commandId: 'player-roll-1',
        gameId,
        actorId: 'Ada',
        expectedVersion: versionAtStart,
        type: 'ROLL',
        payload: {},
      });
      release();
      await blocker;
      const playerResult = await playerRoll;

      assert.equal(playerResult.ok, false, 'the deadline applied first; the player command is stale');
      if (!playerResult.ok) assert.equal(playerResult.error.code, 'VERSION_CONFLICT');
      const auto = autoCommandsOf(db, gameId);
      assert.equal(auto.length, 1);
      assert.equal(auto[0].type, 'ROLL');
      assert.equal(auto[0].actorId, 'Ada');
    } finally {
      host.dispose();
    }
  });

  it('criterion 7 — race: a player command ahead of the expiry keeps its fresh window (stale deadline dropped)', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const tick: Tick = (ms) => tickAndFlush(t, ms);
    const gameId = 'g-dl-race-b';
    const host = makeHost(gameId);
    try {
      await startGame(host, gameId);
      const versionAtStart = host.clientState.version;

      let release!: () => void;
      const blocker = host.runExclusive(() => new Promise<void>((resolve) => { release = resolve; }));
      const playerRoll = host.submit({ gameId, actorId: 'Ada' }, {
        commandId: 'player-roll-2',
        gameId,
        actorId: 'Ada',
        expectedVersion: versionAtStart,
        type: 'ROLL',
        payload: {},
      });
      await tick(50); // expiry queues BEHIND the player command
      release();
      await blocker;
      const playerResult = await playerRoll;

      assert.equal(playerResult.ok, true, 'the player command was composed against the current version');
      // The stale expiry must not consume the freshly granted window.
      await tick(49);
      assert.equal(autoCommandsOf(db, gameId).length, 0, 'the stale deadline was dropped, not applied');
      assert.notEqual(host.deadlineBroadcast.turnExpiresAtMs, null, 'a full fresh window stands');
    } finally {
      host.dispose();
    }
  });

  it('criterion 7 — a resumed host re-arms from the snapshot and acts after restart', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const tick: Tick = (ms) => tickAndFlush(t, ms);
    const gameId = 'g-dl-resume';
    const first = makeHost(gameId);
    try {
      await startGame(first, gameId);
      first.dispose();

      const resumed = GameHost.resume(db, io, gameId, { deadlinePolicy: SHORT_POLICY });
      assert.ok(resumed, 'the snapshot resumes');
      try {
        assert.notEqual(resumed.deadlineBroadcast.turnExpiresAtMs, null, 'the window re-armed from the snapshot');
        await tick(50);
        const auto = autoCommandsOf(db, gameId);
        assert.equal(auto.length, 1);
        assert.equal(auto[0].type, 'ROLL', 'the resumed host acts on expiry');
      } finally {
        resumed.dispose();
      }
    } finally {
      first.dispose();
    }
  });

  it('the published policy matches the spec: Classic 90s / Quick 60s / Blitz 45s turn, 30s auction', () => {
    assert.deepEqual(DEFAULT_DEADLINE_POLICY.turnMs, { CLASSIC: 90_000, QUICK: 60_000, BLITZ: 45_000 });
    assert.equal(DEFAULT_DEADLINE_POLICY.auctionBidMs, 30_000);
  });
});

// ---------------------------------------------------------------------------
// D — gateway wiring: the deadline broadcast on create and join

describe('game:deadline broadcast (gateway wiring)', () => {
  let harness: TestHarness;

  before(async () => {
    harness = await startHarness();
  });
  after(() => harness.close());

  it('the creator and a joiner each receive the current windows (lobby: nothing armed)', { timeout: 30_000 }, async () => {
    type Broadcast = { gameId: string; turnExpiresAtMs: number | null; auctionExpiresAtMs: number | null };
    const creator = await harness.connect();
    const creatorTap = harness.tap<Broadcast>(creator, 'game:deadline');
    const created = (await harness.ack(creator, 'game:create', { mode: 'CLASSIC', seatCount: 2, name: 'Player 1' })) as
      | { ok: boolean; roomCode?: string; gameId?: string }
      | undefined;
    assert.ok(created?.ok, 'create must succeed');

    const joiner = await harness.connect();
    const joinerTap = harness.tap<Broadcast>(joiner, 'game:deadline');
    const joined = (await harness.ack(joiner, 'game:join', { code: created.roomCode, name: 'Player 2' })) as { ok: boolean } | undefined;
    assert.ok(joined?.ok, 'join must succeed');

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(creatorTap.seen.length, 1, 'the creator got the create-time broadcast');
    assert.equal(creatorTap.seen[0].gameId, created.gameId);
    assert.equal(creatorTap.seen[0].turnExpiresAtMs, null, 'the lobby arms no turn window');
    assert.equal(creatorTap.seen[0].auctionExpiresAtMs, null, 'the lobby arms no auction window');
    assert.equal(joinerTap.seen.length, 1, 'the joiner got the join-time broadcast');
    assert.equal(joinerTap.seen[0].gameId, created.gameId);
    assert.equal(joinerTap.seen[0].turnExpiresAtMs, null);
  });
});
