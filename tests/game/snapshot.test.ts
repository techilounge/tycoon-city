/** Snapshot contract tests (spec §2.4): round-trip, version gating, clean refusal. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { applyCommand, createGame } from '../../src/lib/game/engine/reducer';
import { rngForState } from '../../src/lib/game/rng';
import { buildSnapshot, parseSnapshot, serializeSnapshot, validateGameStateShape, type GameSnapshot } from '../../src/lib/game/snapshot-schema';
import { SNAPSHOT_SCHEMA_VERSION, RULES_VERSION, type GameState } from '../../src/lib/game/types';
import { makeCommand, makeGame, commandId, GAME_ID, PLAYER_IDS, SEED } from './helpers';

function advancedState() {
  const { state } = makeGame();
  const started = applyCommand(state, makeCommand('START_GAME', { expectedVersion: 0 }), rngForState(state.rngState));
  assert.ok(started.ok);
  if (!started.ok) throw new Error('unreachable');
  const saved = applyCommand(started.state, makeCommand('SAVE_SNAPSHOT', { expectedVersion: started.state.version, commandId: commandId() }), rngForState(started.state.rngState));
  assert.ok(saved.ok);
  if (!saved.ok) throw new Error('unreachable');
  return saved.state;
}

test('snapshot: serialize → validate → load round-trips an in-progress game', () => {
  const state = advancedState();
  const raw = serializeSnapshot(buildSnapshot(state));
  const parsed = parseSnapshot(raw);
  assert.ok(parsed.ok);
  if (parsed.ok) {
    assert.equal(parsed.snapshot.schemaVersion, SNAPSHOT_SCHEMA_VERSION);
    assert.equal(parsed.snapshot.rulesVersion, RULES_VERSION);
    assert.equal(parsed.snapshot.gameId, GAME_ID);
    assert.equal(parsed.snapshot.seed, SEED);
    assert.equal(parsed.snapshot.stateVersion, state.version);
    assert.deepEqual(parsed.snapshot.state, state, 'round-trip is lossless');
    assert.equal(parsed.snapshot.state.rngState, state.rngState, 'rng word survives the round-trip');
    assert.deepEqual(parsed.snapshot.state.processedCommandIds, state.processedCommandIds);
  }
});

test('snapshot: round-trip state resumes identically (play after load equals uninterrupted play)', () => {
  const state = advancedState();
  const raw = serializeSnapshot(buildSnapshot(state));
  const parsed = parseSnapshot(raw);
  assert.ok(parsed.ok);
  if (parsed.ok) {
    const nextCommand = makeCommand('SAVE_SNAPSHOT', { expectedVersion: state.version, commandId: commandId() });
    const fromLoaded = applyCommand(parsed.snapshot.state, nextCommand, rngForState(parsed.snapshot.state.rngState));
    const fromLive = applyCommand(state, nextCommand, rngForState(state.rngState));
    assert.ok(fromLoaded.ok && fromLive.ok);
    if (fromLoaded.ok && fromLive.ok) {
      assert.deepEqual(fromLoaded.state, fromLive.state, 'loaded state continues exactly where the live state left off');
    }
  }
});

test('snapshot: unknown schemaVersion is REFUSED, never silently loaded', () => {
  const state = advancedState();
  const snapshot = buildSnapshot(state);
  for (const bogus of [SNAPSHOT_SCHEMA_VERSION + 1, SNAPSHOT_SCHEMA_VERSION - 1, 0, 999]) {
    const tampered = serializeSnapshot({ ...snapshot, schemaVersion: bogus });
    const result = parseSnapshot(tampered);
    assert.equal(result.ok, false, `schemaVersion ${bogus} must be refused`);
    if (result.ok === false) {
      assert.equal(result.reason, 'UNKNOWN_SCHEMA_VERSION');
      assert.match(result.message, /not supported by this build/);
      assert.ok(result.details && 'found' in result.details);
    }
  }
});

test('snapshot: unsupported rulesVersion is refused (version-gated replay, spec §3)', () => {
  const state = advancedState();
  const snapshot = buildSnapshot(state);
  const tampered = serializeSnapshot({ ...snapshot, rulesVersion: RULES_VERSION + 1, state: { ...state, rulesVersion: RULES_VERSION + 1 } });
  const result = parseSnapshot(tampered);
  assert.equal(result.ok, false);
  if (result.ok === false) assert.equal(result.reason, 'UNSUPPORTED_RULES_VERSION');
});

test('snapshot: malformed JSON and non-object payloads are refused MALFORMED', () => {
  const badJson = parseSnapshot('{not json');
  assert.equal(badJson.ok, false);
  if (badJson.ok === false) assert.equal(badJson.reason, 'MALFORMED');
  const badShape = parseSnapshot('[1,2,3]');
  assert.equal(badShape.ok, false);
  if (badShape.ok === false) assert.equal(badShape.reason, 'MALFORMED');
});

test('snapshot: missing or wrong-typed header fields are refused MALFORMED', () => {
  const state = advancedState();
  const snapshot = buildSnapshot(state);
  const cases: Array<Record<string, unknown>> = [
    { ...snapshot, gameId: undefined },
    { ...snapshot, gameId: '' },
    { ...snapshot, seed: 'not-a-number' },
    { ...snapshot, stateVersion: 'many' },
    { ...snapshot, schemaVersion: 'one' },
    { ...snapshot, state: undefined },
  ];
  for (const tampered of cases) {
    const result = parseSnapshot(JSON.stringify(tampered));
    assert.equal(result.ok, false);
    if (result.ok === false) assert.equal(result.reason, 'MALFORMED');
  }
});

test('snapshot: header/state mismatches are refused INCONSISTENT', () => {
  const state = advancedState();
  const snapshot = buildSnapshot(state);
  const wrongVersion = parseSnapshot(JSON.stringify({ ...snapshot, stateVersion: snapshot.stateVersion + 5 }));
  assert.equal(wrongVersion.ok, false);
  if (wrongVersion.ok === false) assert.equal(wrongVersion.reason, 'INCONSISTENT');
  const wrongId = parseSnapshot(JSON.stringify({ ...snapshot, gameId: 'other-game' }));
  assert.equal(wrongId.ok, false);
  if (wrongId.ok === false) assert.equal(wrongId.reason, 'INCONSISTENT');
  const wrongSeed = parseSnapshot(JSON.stringify({ ...snapshot, seed: snapshot.seed ^ 1 }));
  assert.equal(wrongSeed.ok, false);
  if (wrongSeed.ok === false) assert.equal(wrongSeed.reason, 'INCONSISTENT');
});

test('snapshot: structurally impossible states are refused INCONSISTENT', () => {
  const state = advancedState();
  const snapshot = buildSnapshot(state);
  const cases: unknown[] = [
    { ...snapshot.state, players: [] },
    { ...snapshot.state, phase: 'SOMEWHERE_ELSE' },
    { ...snapshot.state, turnPhase: 'NOT_A_PHASE' },
    { ...snapshot.state, rngState: -5 },
    { ...snapshot.state, rngState: 1.5 },
    { ...snapshot.state, processedCommandIds: 'all-of-them' },
    { ...snapshot.state, activePlayerId: 'ghost' },
    { ...snapshot.state, players: [...state.players, { id: 'alice', seat: 9, eliminated: false }] },
  ];
  for (const brokenState of cases) {
    const result = parseSnapshot(JSON.stringify({ ...snapshot, state: brokenState }));
    assert.equal(result.ok, false, 'impossible state must be refused');
    if (result.ok === false) assert.equal(result.reason, 'INCONSISTENT');
  }
});

test('snapshot: validateGameStateShape accepts the real state and rejects garbage', () => {
  const state = advancedState();
  assert.equal(validateGameStateShape(state), true);
  assert.equal(validateGameStateShape(null), false);
  assert.equal(validateGameStateShape('state'), false);
  assert.equal(validateGameStateShape({}), false);
});

test('snapshot: LOBBY and GAME_OVER states round-trip', () => {
  const created = createGame({ gameId: GAME_ID, seed: SEED, playerIds: [...PLAYER_IDS] });
  assert.ok(created.ok);
  if (created.ok) {
    const parsed = parseSnapshot(serializeSnapshot(buildSnapshot(created.state)));
    assert.ok(parsed.ok);
    const over = parseSnapshot(serializeSnapshot(buildSnapshot({ ...created.state, phase: 'GAME_OVER', turnPhase: null, activePlayerId: null })));
    assert.ok(over.ok);
  }
});

test('snapshot: serializeSnapshot is byte-stable for equal snapshots', () => {
  const state = advancedState();
  const a = serializeSnapshot(buildSnapshot(state));
  const b = serializeSnapshot(buildSnapshot(structuredClone(state) as typeof state));
  assert.equal(a, b);
});

test('snapshot: GameSnapshot type carries schemaVersion as the rollback gate', () => {
  const snapshot: GameSnapshot = buildSnapshot(advancedState());
  assert.equal(typeof snapshot.schemaVersion, 'number');
  assert.equal(snapshot.schemaVersion, SNAPSHOT_SCHEMA_VERSION);
});


// ---------------------------------------------------------------------------
// Schema v2 (PR 8): the bankruptcy waterfall added `round` and `estateSale`,
// and estate auctions carry the BANK_ESTATE reason inside ELIMINATION_AUCTIONS.

/** A hand-built state paused mid-estate-sale: Ada eliminated, the Anvil sold
 *  to Grace, the last estate space (hub) contested at $30. */
function estateMidState() {
  return {
    gameId: 'g-end',
    version: 9,
    phase: 'PLAYING',
    turnPhase: 'ELIMINATION_AUCTIONS',
    mode: 'CLASSIC',
    doublesCount: 0,
    owners: {},
    upgrades: {},
    mortgaged: {},
    eventDeck: { drawPile: [], discardPile: [] },
    debt: null,
    auction: {
      auctionId: 'auction-11',
      spaceId: 'hub-central-relay',
      reason: 'BANK_ESTATE',
      currentBid: 30,
      highBidderId: 'Grace',
      passedPlayerIds: ['Ben'],
      eligiblePlayerIds: ['Grace', 'Ben'],
    },
    trade: null,
    estateSale: { debtorId: 'Ada', pendingSpaceIds: [] },
    rulesVersion: RULES_VERSION,
    seed: 1,
    rngState: 424242,
    players: [
      { id: 'Ada', seat: 0, eliminated: true, position: 5, cash: 0, tokens: { HOLD: 0, RENT_HOLIDAY: 0 }, skipNextTurn: false },
      { id: 'Grace', seat: 1, eliminated: false, position: 2, cash: 1470, tokens: { HOLD: 1, RENT_HOLIDAY: 1 }, skipNextTurn: false },
      { id: 'Ben', seat: 2, eliminated: false, position: 3, cash: 1500, tokens: { HOLD: 0, RENT_HOLIDAY: 0 }, skipNextTurn: false },
    ],
    activePlayerId: 'Ada',
    turn: 3,
    round: 1,
    lastEventSequence: 11,
    processedCommandIds: [],
  } as unknown as GameState;
}

test('snapshot: a mid-elimination-auction state round-trips losslessly (schema v2)', () => {
  const state = estateMidState();
  const raw = serializeSnapshot(buildSnapshot(state));
  const parsed = parseSnapshot(raw);
  assert.ok(parsed.ok, `the estate state must load: ${parsed.ok ? '' : parsed.message}`);
  if (parsed.ok) {
    assert.equal(parsed.snapshot.schemaVersion, SNAPSHOT_SCHEMA_VERSION);
    assert.deepEqual(parsed.snapshot.state, state, 'round-trip is lossless, estate sale included');
    assert.equal(parsed.snapshot.state.estateSale?.debtorId, 'Ada');
    assert.equal(parsed.snapshot.state.auction?.reason, 'BANK_ESTATE');
  }
});

test('snapshot: play after loading a mid-estate state equals uninterrupted play', () => {
  const state = estateMidState();
  const parsed = parseSnapshot(serializeSnapshot(buildSnapshot(state)));
  assert.ok(parsed.ok);
  if (parsed.ok) {
    // Grace outbids herself at $40 as the sole unpassed bidder: she wins and
    // pays inside the command, the estate sale completes, and the interrupted
    // turn hands over — identical from the live state and the loaded one.
    const nextCommand = makeCommand('BID', { actorId: 'Grace', gameId: 'g-end', expectedVersion: state.version, payload: { auctionId: 'auction-11', amount: 40 }, commandId: commandId() });
    const fromLoaded = applyCommand(parsed.snapshot.state, nextCommand, rngForState(parsed.snapshot.state.rngState));
    const fromLive = applyCommand(state, nextCommand, rngForState(state.rngState));
    assert.ok(fromLoaded.ok && fromLive.ok);
    if (fromLoaded.ok && fromLive.ok) {
      assert.deepEqual(fromLoaded.state, fromLive.state, 'the loaded estate sale finishes exactly as the live one');
      assert.equal(fromLoaded.state.estateSale, null);
      assert.equal(fromLoaded.state.owners['hub-central-relay'], 'Grace');
    }
  }
});

test('snapshot: estate-sale invariants are enforced at the persistence boundary', () => {
  const state = estateMidState();
  const snapshot = buildSnapshot(state);
  const cases: Array<{ broken: Record<string, unknown>; why: string }> = [
    { broken: { ...snapshot, state: { ...state, estateSale: null } }, why: 'the ELIMINATION_AUCTIONS phase with no open estate is malformed' },
    { broken: { ...snapshot, state: { ...state, estateSale: { debtorId: 'Zoe', pendingSpaceIds: [] } } }, why: 'an estate debtor must be a real player' },
    { broken: { ...snapshot, state: { ...state, estateSale: { debtorId: 'Ada', pendingSpaceIds: 'hub' } } }, why: 'pending spaces are an array' },
    { broken: { ...snapshot, state: { ...state, round: 'one' } }, why: 'round is an integer' },
    { broken: { ...snapshot, state: { ...state, auction: { ...state.auction, reason: 'DECLINED_PURCHASE' } } }, why: 'a DECLINED_PURCHASE auction never lives in ELIMINATION_AUCTIONS' },
  ];
  for (const { broken, why } of cases) {
    const result = parseSnapshot(JSON.stringify(broken));
    assert.equal(result.ok, false, why);
    if (result.ok === false) assert.equal(result.reason, 'INCONSISTENT');
  }
});
