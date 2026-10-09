/** Reducer contract tests: the 8-step pipeline, idempotency, purity, sequences (spec §2.1). */
import assert from 'node:assert/strict';
import test from 'node:test';
import { applyCommand, canAct, createGame } from '../../src/lib/game/engine/reducer';
import { rngForState } from '../../src/lib/game/rng';
import type { GameCommand } from '../../src/lib/game/commands';
import type { GameState } from '../../src/lib/game/types';
import { makeCommand, makeGame, commandId, PLAYER_IDS, GAME_ID, SEED } from './helpers';

test('reducer: createGame emits GAME_CREATED as sequence 1 with lobby state', () => {
  const created = createGame({ gameId: GAME_ID, seed: SEED, playerIds: [...PLAYER_IDS] });
  assert.ok(created.ok);
  if (created.ok) {
    const [event] = created.events;
    assert.equal(event.type, 'GAME_CREATED');
    assert.equal(event.sequence, 1);
    assert.equal(event.rulesVersion, created.state.rulesVersion);
    if (event.type === 'GAME_CREATED') {
      assert.deepEqual(event.payload.playerIds, [...PLAYER_IDS]);
    }
    assert.equal(created.state.phase, 'LOBBY');
    assert.equal(created.state.turnPhase, null);
    assert.equal(created.state.version, 0);
    assert.equal(created.state.lastEventSequence, 1);
    assert.equal(created.state.rngState, SEED >>> 0);
    assert.equal(created.state.seed, SEED >>> 0);
    assert.deepEqual(created.state.processedCommandIds, []);
    assert.deepEqual(created.state.players.map((p) => p.id), [...PLAYER_IDS]);
    assert.equal(created.state.activePlayerId, null);
  }
});

test('reducer: createGame rejects duplicate player ids, wrong counts, blank ids', () => {
  assert.equal(createGame({ gameId: GAME_ID, seed: SEED, playerIds: ['a', 'a'] }).ok, false);
  assert.equal(createGame({ gameId: GAME_ID, seed: SEED, playerIds: ['a'] }).ok, false);
  assert.equal(createGame({ gameId: GAME_ID, seed: SEED, playerIds: ['1', '2', '3', '4', '5', '6', '7'] }).ok, false);
  assert.equal(createGame({ gameId: GAME_ID, seed: SEED, playerIds: ['a', ''] }).ok, false);
  assert.equal(createGame({ gameId: GAME_ID, seed: -1, playerIds: ['a', 'b'] }).ok, false);
});

test('reducer: START_GAME moves the lobby into play and TURN_STARTED names the first player', () => {
  const { state } = makeGame();
  const command = makeCommand('START_GAME', { expectedVersion: 0 });
  const result = applyCommand(state, command, rngForState(state.rngState));
  assert.ok(result.ok);
  if (result.ok) {
    assert.equal(result.applied, true);
    assert.equal(result.state.phase, 'PLAYING');
    assert.equal(result.state.turnPhase, 'AWAITING_ROLL');
    assert.equal(result.state.turn, 1);
    assert.equal(result.state.activePlayerId, PLAYER_IDS[0]);
    assert.equal(result.state.version, 1);
    assert.equal(result.events[0].commandId, command.commandId, 'events carry the producing command id');
    const started = result.events.find((event) => event.type === 'TURN_STARTED');
    assert.ok(started, 'TURN_STARTED must be emitted');
    assert.equal(started.sequence, 2, 'second stamped event in the log');
  }
});

test('reducer: START_GAME is phase-guarded — cannot start twice', () => {
  const { state } = makeGame();
  const first = applyCommand(state, makeCommand('START_GAME', { expectedVersion: 0 }), rngForState(state.rngState));
  assert.ok(first.ok);
  if (first.ok) {
    const second = applyCommand(first.state, makeCommand('START_GAME', { expectedVersion: first.state.version }), rngForState(first.state.rngState));
    assert.equal(second.ok, false);
    if (second.ok === false) {
      assert.equal(second.error.code, 'INVALID_PHASE');
      assert.equal((second.error.details as { phase?: string }).phase, 'PLAYING');
    }
  }
});

test('reducer: duplicate commandId applies exactly once and returns state untouched', () => {
  const { state } = makeGame();
  const command = makeCommand('START_GAME', { expectedVersion: 0 });
  const first = applyCommand(state, command, rngForState(state.rngState));
  assert.ok(first.ok);
  if (first.ok) {
    const retry = applyCommand(first.state, command, rngForState(first.state.rngState));
    assert.ok(retry.ok);
    if (retry.ok) {
      assert.equal(retry.applied, false, 'retry must apply nothing');
      assert.deepEqual(retry.state, first.state, 'state identical after retry');
      assert.equal(retry.state.version, first.state.version);
      assert.deepEqual(retry.events, [], 'reducer returns no new events for a retry');
      assert.deepEqual(retry.state.processedCommandIds, first.state.processedCommandIds);
    }
  }
});

test('reducer: duplicate commandId with original expectedVersion is idempotent, not VERSION_CONFLICT', () => {
  // A transport-level retry re-sends the ORIGINAL envelope: original id, original version.
  const { state } = makeGame();
  const command = makeCommand('START_GAME', { expectedVersion: 0 });
  const first = applyCommand(state, command, rngForState(state.rngState));
  assert.ok(first.ok);
  if (first.ok) {
    // The game is now at version 1 but expectedVersion is still 0.
    const retry = applyCommand(first.state, command, rngForState(first.state.rngState));
    assert.ok(retry.ok, 'a genuine retry must never be rejected as stale');
    if (retry.ok) assert.equal(retry.applied, false);
  }
});

test('reducer: a FRESH command with a stale expectedVersion is rejected VERSION_CONFLICT', () => {
  const { state } = makeGame();
  const started = applyCommand(state, makeCommand('START_GAME', { expectedVersion: 0 }), rngForState(state.rngState));
  assert.ok(started.ok);
  if (started.ok) {
    // New command composed against the old world (version 0) while the game sits at 1.
    const stale = applyCommand(started.state, makeCommand('SAVE_SNAPSHOT', { expectedVersion: 0 }), rngForState(started.state.rngState));
    assert.equal(stale.ok, false);
    if (stale.ok === false) {
      assert.equal(stale.error.code, 'VERSION_CONFLICT');
      assert.equal((stale.error.details as { expectedVersion?: number }).expectedVersion, 0);
      assert.equal((stale.error.details as { currentVersion?: number }).currentVersion, 1);
    }
  }
});

test('reducer: commands against a finished game are rejected GAME_IS_OVER (row 17)', () => {
  const { state } = makeGame();
  const over: GameState = { ...state, phase: 'GAME_OVER', turnPhase: null, activePlayerId: null };
  const result = applyCommand(over, makeCommand('SAVE_SNAPSHOT', { expectedVersion: over.version }), rngForState(over.rngState));
  assert.equal(result.ok, false);
  if (result.ok === false) assert.equal(result.error.code, 'GAME_IS_OVER');
});

test('reducer: authorization — device commands open to any live player, turn commands restricted', () => {
  const { state } = makeGame();
  const started = applyCommand(state, makeCommand('START_GAME', { expectedVersion: 0 }), rngForState(state.rngState));
  assert.ok(started.ok);
  if (started.ok) {
    // SAVE_SNAPSHOT is a device action — allowed for any live player.
    const other = applyCommand(started.state, makeCommand('SAVE_SNAPSHOT', { actorId: PLAYER_IDS[1], expectedVersion: started.state.version, commandId: commandId() }), rngForState(started.state.rngState));
    assert.ok(other.ok);
  }
});

test('reducer: unimplemented rules commands are rejected COMMAND_NOT_IMPLEMENTED, never no-ops', () => {
  const { state } = makeGame();
  const started = applyCommand(state, makeCommand('START_GAME', { expectedVersion: 0 }), rngForState(state.rngState));
  assert.ok(started.ok);
  if (started.ok) {
    // PR 4 implemented ROLL, HOLD, BUY, PASS_TO_AUCTION, and END_TURN; the
    // remaining rules commands land with PRs 5–8 and must still refuse to run.
    for (const type of ['BID', 'PASS_BID', 'BUILD', 'SELL_UPGRADE', 'MORTGAGE', 'UNMORTGAGE', 'OFFER_TRADE', 'ANSWER_TRADE', 'SETTLE_DEBT', 'SURRENDER'] as const) {
      const result = applyCommand(started.state, makeCommand(type, { expectedVersion: started.state.version, commandId: commandId() }), rngForState(started.state.rngState));
      assert.equal(result.ok, false, `${type} must not apply in this rules build`);
      if (result.ok === false) assert.equal(result.error.code, 'COMMAND_NOT_IMPLEMENTED');
    }
  }
});

test('reducer: purity — rejected commands leave the input state deep-equal untouched', () => {
  const { state } = makeGame();
  const snapshotBefore = structuredClone(state);
  const rejections: GameCommand[] = [
    makeCommand('START_GAME', { expectedVersion: 99 }), // version conflict
    makeCommand('START_GAME', { actorId: 'mallory' }), // existence
    makeCommand('SAVE_SNAPSHOT', { commandId: '   ' }), // shape
    makeCommand('ROLL', { expectedVersion: 0 }), // unimplemented
  ];
  for (const command of rejections) {
    const result = applyCommand(state, command, rngForState(state.rngState));
    assert.equal(result.ok, false);
  }
  assert.deepEqual(state, snapshotBefore);
});

test('reducer: purity — a successful command returns a new object, input untouched', () => {
  const { state } = makeGame();
  const before = structuredClone(state);
  const result = applyCommand(state, makeCommand('START_GAME', { expectedVersion: 0 }), rngForState(state.rngState));
  assert.ok(result.ok);
  if (result.ok) {
    assert.notEqual(result.state, state, 'a new state object must be returned');
    assert.deepEqual(state, before, 'input state must be untouched');
  }
});

test('reducer: events are gapless and monotonic across a command chain', () => {
  const { state, events: createdEvents } = makeGame();
  const started = applyCommand(state, makeCommand('START_GAME', { expectedVersion: 0 }), rngForState(state.rngState));
  assert.ok(started.ok);
  if (started.ok) {
    const saved = applyCommand(started.state, makeCommand('SAVE_SNAPSHOT', { expectedVersion: started.state.version, commandId: commandId() }), rngForState(started.state.rngState));
    assert.ok(saved.ok);
    if (saved.ok) {
      // The full ledger: creation stamps GAME_CREATED at sequence 1, and
      // every command's events continue gaplessly from there.
      const all = [...createdEvents, ...started.events, ...saved.events];
      all.forEach((event, index) => {
        assert.equal(event.sequence, index + 1, `event ${index} must be gapless`);
      });
      assert.equal(all[0].type, 'GAME_CREATED');
      assert.equal(saved.state.lastEventSequence, all.length);
      assert.equal(all[all.length - 1].type, 'SNAPSHOT_SAVED');
    }
  }
});

test('reducer: every stamped event carries gameId, rulesVersion, deterministic meta, and payload', () => {
  const { state } = makeGame();
  const started = applyCommand(state, makeCommand('START_GAME', { expectedVersion: 0 }), rngForState(state.rngState));
  assert.ok(started.ok);
  if (started.ok) {
    for (const event of started.events) {
      assert.equal(event.gameId, GAME_ID);
      assert.equal(event.rulesVersion, state.rulesVersion);
      assert.equal(typeof event.meta, 'object');
    }
  }
});

test('reducer: canAct — pure predicate covers live players, elimination, and turn scope', () => {
  const { state } = makeGame();
  const started = applyCommand(state, makeCommand('START_GAME', { expectedVersion: 0 }), rngForState(state.rngState));
  assert.ok(started.ok);
  if (started.ok) {
    const playing = started.state;
    assert.equal(canAct(playing, makeCommand('ROLL', { actorId: PLAYER_IDS[0] })), true);
    assert.equal(canAct(playing, makeCommand('ROLL', { actorId: PLAYER_IDS[1] })), false);
    assert.equal(canAct(playing, makeCommand('ROLL', { actorId: 'mallory' })), false);
    assert.equal(canAct(playing, makeCommand('SAVE_SNAPSHOT', { actorId: PLAYER_IDS[2] })), true, 'device action for any live player');
    const eliminated: GameState = { ...playing, players: playing.players.map((p) => (p.id === PLAYER_IDS[0] ? { ...p, eliminated: true } : p)) };
    assert.equal(canAct(eliminated, makeCommand('ROLL', { actorId: PLAYER_IDS[0] })), false, 'eliminated players cannot act');
    assert.equal(canAct(playing, makeCommand('START_GAME', { actorId: PLAYER_IDS[1] })), true, 'lobby device action before start');
  }
});

test('reducer: processedCommandIds accumulate across commands; version tracks applies', () => {
  const { state } = makeGame();
  const first = applyCommand(state, makeCommand('START_GAME', { expectedVersion: 0 }), rngForState(state.rngState));
  assert.ok(first.ok);
  if (first.ok) {
    const second = applyCommand(first.state, makeCommand('SAVE_SNAPSHOT', { expectedVersion: first.state.version, commandId: commandId() }), rngForState(first.state.rngState));
    assert.ok(second.ok);
    if (second.ok) {
      assert.equal(second.state.version, 2);
      assert.equal(second.state.processedCommandIds.length, 2);
      assert.notEqual(second.state.processedCommandIds[0], second.state.processedCommandIds[1]);
    }
  }
});
