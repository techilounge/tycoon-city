/** Replay and hashing contract tests (spec §3): identical history → identical state hash. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { applyCommand } from '../../src/lib/game/engine/reducer';
import { replayFromSeed, replayCommands, stateHash, canonicalJson } from '../../src/lib/game/engine/replay';
import { rngForState } from '../../src/lib/game/rng';
import type { GameCommand } from '../../src/lib/game/commands';
import { makeCommand, makeGame, commandId, PLAYER_IDS, GAME_ID, SEED } from './helpers';

/** Fold commands live (as a player would through the reducer). */
function liveFold(commands: readonly GameCommand[]) {
  const { state } = makeGame();
  const allEvents = [];
  let current = state;
  let applied = 0;
  for (const command of commands) {
    const result = applyCommand(current, command, rngForState(current.rngState));
    if (!result.ok) throw result.error;
    current = result.state;
    allEvents.push(...result.events);
    if (result.applied) applied += 1;
  }
  return { state: current, events: allEvents, applied };
}

test('replay: live fold vs replayFromSeed produce identical state hashes', () => {
  const commands = [makeCommand('START_GAME', { expectedVersion: 0 }), makeCommand('SAVE_SNAPSHOT', { expectedVersion: 1 }), makeCommand('SAVE_SNAPSHOT', { expectedVersion: 2 })];
  const live = liveFold(commands);
  const replayed = replayFromSeed({ gameId: GAME_ID, seed: SEED, playerIds: [...PLAYER_IDS], commands });
  assert.equal(stateHash(replayed.state), stateHash(live.state));
  assert.equal(replayed.appliedCount, live.applied);
  assert.deepEqual(replayed.events, live.events);
});

test('replay: 1,000-command log refolds to the identical hash (spec contract)', () => {
  // Alternate START_GAME-stable state with SAVE_SNAPSHOT churn: 1,000 valid commands.
  const commands: GameCommand[] = [];
  commands.push(makeCommand('START_GAME', { expectedVersion: 0 }));
  for (let i = 1; i < 1_000; i++) {
    commands.push(makeCommand('SAVE_SNAPSHOT', { expectedVersion: i, commandId: commandId() }));
  }
  const live = liveFold(commands);
  assert.equal(live.applied, 1_000);
  const replayed = replayFromSeed({ gameId: GAME_ID, seed: SEED, playerIds: [...PLAYER_IDS], commands });
  assert.equal(stateHash(replayed.state), stateHash(live.state));
  assert.equal(replayed.state.version, 1_000);
  assert.equal(replayed.state.lastEventSequence, 1 + 1_000, 'GAME_CREATED + one event per command');
});

test('replay: 1,000-command log hash is stable across two independent replays', () => {
  const commands: GameCommand[] = [makeCommand('START_GAME', { expectedVersion: 0 })];
  for (let i = 1; i < 1_000; i++) commands.push(makeCommand('SAVE_SNAPSHOT', { expectedVersion: i, commandId: commandId() }));
  const a = replayFromSeed({ gameId: GAME_ID, seed: SEED, playerIds: [...PLAYER_IDS], commands });
  const b = replayFromSeed({ gameId: GAME_ID, seed: SEED, playerIds: [...PLAYER_IDS], commands });
  assert.equal(stateHash(a.state), stateHash(b.state));
});

test('replay: duplicate commandIds inside a log apply exactly once (idempotent fold)', () => {
  const duplicate = makeCommand('START_GAME', { expectedVersion: 0 });
  const commands = [duplicate, duplicate, duplicate, makeCommand('SAVE_SNAPSHOT', { expectedVersion: 1 })];
  const live = liveFold(commands);
  const replayed = replayFromSeed({ gameId: GAME_ID, seed: SEED, playerIds: [...PLAYER_IDS], commands });
  assert.equal(stateHash(replayed.state), stateHash(live.state));
  assert.equal(replayed.appliedCount, 2, 'duplicate folds are no-ops');
  assert.equal(replayed.state.version, 2);
});

test('replay: rejected commands fold as no-ops and are reported, state unaffected', () => {
  const commands = [
    makeCommand('START_GAME', { expectedVersion: 0 }),
    makeCommand('SAVE_SNAPSHOT', { expectedVersion: 77 }), // stale — rejected
    makeCommand('SAVE_SNAPSHOT', { expectedVersion: 1 }),
  ];
  const live = liveFold(commands.slice(0, 1).concat(commands.slice(2)));
  const withRejection = replayFromSeed({ gameId: GAME_ID, seed: SEED, playerIds: [...PLAYER_IDS], commands });
  assert.equal(withRejection.rejected.length, 1);
  assert.equal(withRejection.rejected[0].index, 1);
  assert.equal(withRejection.rejected[0].error.code, 'VERSION_CONFLICT');
  assert.equal(stateHash(withRejection.state), stateHash(live.state), 'rejection is a no-op in the fold');
  assert.equal(withRejection.appliedCount, 2);
});

test('replay: replayCommands continues from a mid-game state (snapshot continuation)', () => {
  const firstLeg = [makeCommand('START_GAME', { expectedVersion: 0 }), makeCommand('SAVE_SNAPSHOT', { expectedVersion: 1 })];
  const live = liveFold(firstLeg);
  const secondLeg = [makeCommand('SAVE_SNAPSHOT', { expectedVersion: 2 })];
  const continued = replayCommands(live.state, secondLeg);
  const fullLive = liveFold([...firstLeg, ...secondLeg]);
  assert.equal(stateHash(continued.state), stateHash(fullLive.state));
});

test('replay: event order is identical between live fold and replay', () => {
  const commands = [makeCommand('START_GAME', { expectedVersion: 0 }), makeCommand('SAVE_SNAPSHOT', { expectedVersion: 1 })];
  const live = liveFold(commands);
  const replayed = replayFromSeed({ gameId: GAME_ID, seed: SEED, playerIds: [...PLAYER_IDS], commands });
  assert.deepEqual(replayed.events, live.events);
  assert.deepEqual(replayed.events.map((e) => e.sequence), live.events.map((e) => e.sequence));
});

test('replay: canonicalJson sorts keys recursively and is byte-stable', () => {
  const a = { b: 1, a: { d: [1, { z: 2, y: 3 }], c: 'x' } };
  const b = { a: { c: 'x', d: [1, { y: 3, z: 2 }] }, b: 1 };
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(canonicalJson({ nested: { deep: [true, null, 's', 0] } }), '{"nested":{"deep":[true,null,"s",0]}}');
  assert.throws(() => canonicalJson({ bad: Number.NaN }), /non-finite/);
});

test('replay: stateHash detects any change and is 16 hex chars', () => {
  const { state } = makeGame();
  const hash = stateHash(state);
  assert.match(hash, /^[0-9a-f]{16}$/);
  const tweaked: typeof state = { ...state, turn: 1 };
  assert.notEqual(stateHash(tweaked), hash);
  const reordered = { ...state, players: [...state.players].reverse() };
  assert.notEqual(stateHash(reordered), hash);
  // Key order in an equivalent object must not matter (canonical JSON).
  assert.equal(stateHash({ ...state }), hash);
});

test('replay: hash equality over 1,000 commands with mixed keys — deterministic byte order', () => {
  // Keys inserted in different orders across runs must hash identically
  // because canonical JSON sorts them.
  const commands: GameCommand[] = [makeCommand('START_GAME', { expectedVersion: 0 })];
  for (let i = 1; i < 1_000; i++) commands.push(makeCommand('SAVE_SNAPSHOT', { expectedVersion: i, commandId: commandId() }));
  const forward = replayFromSeed({ gameId: GAME_ID, seed: SEED, playerIds: [...PLAYER_IDS], commands });
  const deepCloned = structuredClone(forward.state) as typeof forward.state;
  assert.equal(stateHash(deepCloned), stateHash(forward.state));
});
