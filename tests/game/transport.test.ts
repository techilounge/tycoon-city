/** Transport seam tests (spec §2.3, §10): sink, event source, snapshot store, Phase 1 wiring. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalCommandSink, InMemorySnapshotStore } from '../../src/lib/game/engine/transport';
import { SNAPSHOT_SCHEMA_VERSION } from '../../src/lib/game/types';
import type { AnyGameEvent } from '../../src/lib/game/events';
import { makeCommand, commandId, PLAYER_IDS, GAME_ID, SEED } from './helpers';

test('transport: LocalCommandSink drives the real reducer in-process', async () => {
  const sink = LocalCommandSink.create({ gameId: GAME_ID, seed: SEED, playerIds: [...PLAYER_IDS] });
  assert.equal(sink.state().phase, 'LOBBY');
  const result = await sink.submit(makeCommand('START_GAME', { expectedVersion: 0 }));
  assert.ok(result.ok);
  if (result.ok) {
    assert.equal(result.applied, true);
    assert.equal(sink.state().phase, 'PLAYING');
    assert.deepEqual(result.events.map((e) => e.type), ['TURN_STARTED']);
  }
});

test('transport: rejected commands leave the sink state unchanged', async () => {
  const sink = LocalCommandSink.create({ gameId: GAME_ID, seed: SEED, playerIds: [...PLAYER_IDS] });
  const before = sink.state();
  const result = await sink.submit(makeCommand('ROLL', { expectedVersion: 0 }));
  assert.equal(result.ok, false);
  assert.deepEqual(sink.state(), before);
});

test('transport: EventSource replays the full log from sequence 1, then delivers live', async () => {
  const sink = LocalCommandSink.create({ gameId: GAME_ID, seed: SEED, playerIds: [...PLAYER_IDS] });
  await sink.submit(makeCommand('START_GAME', { expectedVersion: 0 }));
  const received: AnyGameEvent[] = [];
  const unsubscribe = sink.events.subscribe(GAME_ID, 1, (event) => received.push(event));
  assert.deepEqual(received.map((e) => e.sequence), [1, 2], 'catch-up delivers GAME_CREATED and TURN_STARTED');
  await sink.submit(makeCommand('SAVE_SNAPSHOT', { expectedVersion: 1, commandId: commandId() }));
  assert.deepEqual(received.map((e) => e.sequence), [1, 2, 3], 'live delivery continues after catch-up');
  unsubscribe();
  await sink.submit(makeCommand('SAVE_SNAPSHOT', { expectedVersion: 2, commandId: commandId() }));
  assert.equal(received.length, 3, 'unsubscribe stops delivery');
});

test('transport: EventSource fromSeq catches up only events at or after the sequence', async () => {
  const sink = LocalCommandSink.create({ gameId: GAME_ID, seed: SEED, playerIds: [...PLAYER_IDS] });
  await sink.submit(makeCommand('START_GAME', { expectedVersion: 0 }));
  const received: AnyGameEvent[] = [];
  sink.events.subscribe(GAME_ID, 2, (event) => received.push(event));
  assert.deepEqual(received.map((e) => e.sequence), [2]);
});

test('transport: EventSource filters by gameId', async () => {
  const sink = LocalCommandSink.create({ gameId: GAME_ID, seed: SEED, playerIds: [...PLAYER_IDS] });
  const received: AnyGameEvent[] = [];
  sink.events.subscribe('some-other-game', 0, (event) => received.push(event));
  await sink.submit(makeCommand('START_GAME', { expectedVersion: 0 }));
  assert.deepEqual(received, []);
});

test('transport: duplicate commandId returns the stored original events and applies nothing', async () => {
  const sink = LocalCommandSink.create({ gameId: GAME_ID, seed: SEED, playerIds: [...PLAYER_IDS] });
  const command = makeCommand('START_GAME', { expectedVersion: 0 });
  const first = await sink.submit(command);
  assert.ok(first.ok && first.applied);
  const retry = await sink.submit(command);
  assert.ok(retry.ok);
  if (retry.ok) {
    assert.equal(retry.applied, false);
    assert.deepEqual(retry.events, first.events, 'stored events of the original application are returned');
    assert.equal(sink.state().version, 1, 'state did not move');
    assert.equal(sink.state().processedCommandIds.length, 1);
  }
});

test('transport: SnapshotStore persists on SAVE_SNAPSHOT and reloads a validated state', async () => {
  const store = new InMemorySnapshotStore();
  const sink = LocalCommandSink.create({ gameId: GAME_ID, seed: SEED, playerIds: [...PLAYER_IDS], snapshots: store });
  await sink.submit(makeCommand('START_GAME', { expectedVersion: 0 }));
  await sink.submit(makeCommand('SAVE_SNAPSHOT', { expectedVersion: 1, commandId: commandId() }));
  const loaded = store.load(GAME_ID);
  assert.ok(loaded, 'SAVE_SNAPSHOT persisted a snapshot');
  if (loaded) {
    assert.equal(loaded.schemaVersion, SNAPSHOT_SCHEMA_VERSION);
    assert.equal(loaded.stateVersion, 2, 'version after START_GAME + SAVE_SNAPSHOT');
    assert.equal(loaded.state.phase, 'PLAYING');
    assert.deepEqual(loaded.state, sink.state());
  }
  assert.equal(store.load('missing-game'), null);
});

test('transport: sink exposes a schema-stamped snapshot of the current state', () => {
  const sink = LocalCommandSink.create({ gameId: GAME_ID, seed: SEED, playerIds: [...PLAYER_IDS] });
  const snapshot = sink.snapshot();
  assert.equal(snapshot.schemaVersion, SNAPSHOT_SCHEMA_VERSION);
  assert.equal(snapshot.stateVersion, 0);
  assert.equal(snapshot.gameId, GAME_ID);
});

test('transport: event sequences are gapless across the sink log', async () => {
  const sink = LocalCommandSink.create({ gameId: GAME_ID, seed: SEED, playerIds: [...PLAYER_IDS] });
  await sink.submit(makeCommand('START_GAME', { expectedVersion: 0 }));
  await sink.submit(makeCommand('SAVE_SNAPSHOT', { expectedVersion: 1, commandId: commandId() }));
  await sink.submit(makeCommand('SAVE_SNAPSHOT', { expectedVersion: 2, commandId: commandId() }));
  const sequences: number[] = [];
  sink.events.subscribe(GAME_ID, 1, (event) => sequences.push(event.sequence));
  assert.deepEqual(sequences, [1, 2, 3, 4], 'GAME_CREATED + TURN_STARTED + two SNAPSHOT_SAVED');
});
