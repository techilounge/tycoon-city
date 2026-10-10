/** Save/resume tests (spec §2.4, §11): localStorage adapter, startup planning, resume seam. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalCommandSink } from '../../src/lib/game/engine/transport';
import { buildSnapshot, serializeSnapshot, type GameSnapshot } from '../../src/lib/game/snapshot-schema';
import { LocalSnapshotStore, persistGame, readStartupSnapshot, refusalMessage } from '../../src/lib/game/ui/persistence';
import { GAME_ID, SEED, PLAYER_IDS, makeCommand } from './helpers';

const SNAPSHOT_KEY = 'tycoon-city:save:v2';

/** Map-backed Storage stand-in — the tests run in node, with no localStorage. */
class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

/** A sink with a game underway plus the highest event sequence it emitted. */
async function startedSink(): Promise<{ sink: LocalCommandSink; lastSeq: number }> {
  const sink = LocalCommandSink.create({ gameId: GAME_ID, seed: SEED, playerIds: [...PLAYER_IDS] });
  let lastSeq = 0;
  sink.events.subscribe(GAME_ID, 1, (event) => {
    lastSeq = Math.max(lastSeq, event.sequence);
  });
  const result = await sink.submit(makeCommand('START_GAME', { expectedVersion: 0 }));
  assert.ok(result.ok);
  return { sink, lastSeq };
}

/** Writes raw bytes through the wrapped storage — save() would validate, and the
 *  corrupt / foreign-schema cases need bytes parseSnapshot will refuse. */
function storageSetRaw(store: LocalSnapshotStore, raw: string): void {
  const backend = (store as unknown as { storage: Storage }).storage;
  backend.setItem(SNAPSHOT_KEY, raw);
}

test('persistence: save then load round-trips the snapshot', async () => {
  const { sink } = await startedSink();
  const store = new LocalSnapshotStore(new MemoryStorage());
  const snapshot = buildSnapshot(sink.state());
  store.save(snapshot);
  const loaded = store.load(GAME_ID);
  assert.ok(loaded !== null);
  assert.deepEqual(loaded, snapshot);
});

test('persistence: load refuses a snapshot belonging to another game', async () => {
  const { sink } = await startedSink();
  const store = new LocalSnapshotStore(new MemoryStorage());
  store.save(buildSnapshot(sink.state()));
  assert.equal(store.load('g-someone-else'), null);
});

test('persistence: readStartupSnapshot plans ABSENT, RESUMABLE, and REFUSED', async () => {
  assert.deepEqual(readStartupSnapshot(new LocalSnapshotStore(new MemoryStorage())), { kind: 'ABSENT' });

  const { sink } = await startedSink();
  const store = new LocalSnapshotStore(new MemoryStorage());
  store.save(buildSnapshot(sink.state()));
  const planned = readStartupSnapshot(store);
  assert.equal(planned.kind, 'RESUMABLE');
  if (planned.kind === 'RESUMABLE') assert.equal(planned.snapshot.gameId, GAME_ID);

  const corrupt = new LocalSnapshotStore(new MemoryStorage());
  storageSetRaw(corrupt, '{not json');
  const refused = readStartupSnapshot(corrupt);
  assert.equal(refused.kind, 'REFUSED');
  if (refused.kind === 'REFUSED') assert.match(refused.message, /damaged/);
});

test('persistence: an unknown schemaVersion is refused with a clear message (spec §2.4)', async () => {
  const { sink } = await startedSink();
  const store = new LocalSnapshotStore(new MemoryStorage());
  const foreign = JSON.stringify({ ...buildSnapshot(sink.state()), schemaVersion: 999 });
  storageSetRaw(store, foreign);
  const planned = readStartupSnapshot(store);
  assert.equal(planned.kind, 'REFUSED');
  if (planned.kind === 'REFUSED') {
    assert.match(planned.message, /different version/);
    assert.match(planned.message, /cannot be loaded/);
  }
  // And it was never silently loaded: the store's own load refuses too.
  assert.equal(store.load(GAME_ID), null);
});

test('persistence: refusal copy covers every parse failure reason', () => {
  assert.match(refusalMessage('UNKNOWN_SCHEMA_VERSION'), /different version/);
  assert.match(refusalMessage('UNSUPPORTED_RULES_VERSION'), /rules this version does not support/);
  assert.match(refusalMessage('MALFORMED'), /damaged/);
  assert.match(refusalMessage('INCONSISTENT'), /integrity/);
});

test('persistence: persistGame reports failure when storage refuses the write', async () => {
  const { sink } = await startedSink();
  const throwing = new MemoryStorage();
  throwing.setItem = () => {
    throw new DOMException('quota exceeded', 'QuotaExceededError');
  };
  assert.equal(persistGame(new LocalSnapshotStore(throwing), sink.state(), []), false);
  assert.equal(persistGame(new LocalSnapshotStore(new MemoryStorage()), sink.state(), []), true);
});

test('persistence: LocalCommandSink.resume continues the game from the snapshot', async () => {
  const { sink, lastSeq } = await startedSink();
  const snapshot = buildSnapshot(sink.state());
  const resumed = LocalCommandSink.resume(snapshot);
  assert.deepEqual(resumed.state(), sink.state());

  // The turn advances through the exact same command contract after resume.
  const roll = await resumed.submit(
    makeCommand('ROLL', { expectedVersion: snapshot.state.version, actorId: snapshot.state.activePlayerId ?? PLAYER_IDS[0] }),
  );
  assert.ok(roll.ok);
  if (roll.ok) {
    assert.equal(roll.applied, true);
    assert.ok(resumed.state().version > snapshot.state.version);
  }

  // Sequences continue gaplessly: every resumed event exceeds the pre-resume log.
  const received: number[] = [];
  resumed.events.subscribe(GAME_ID, 1, (event) => received.push(event.sequence));
  await resumed.submit(
    makeCommand('END_TURN', {
      expectedVersion: resumed.state().version,
      actorId: resumed.state().activePlayerId ?? PLAYER_IDS[0],
    }),
  );
  assert.ok(received.length > 0);
  for (const seq of received) assert.ok(seq > lastSeq, `sequence ${seq} continues past ${lastSeq}`);
});

test('persistence: idempotency survives resume — a pre-resume command applies nothing', async () => {
  const sink = LocalCommandSink.create({ gameId: GAME_ID, seed: SEED, playerIds: [...PLAYER_IDS] });
  const startCommand = makeCommand('START_GAME', { expectedVersion: 0 });
  const first = await sink.submit(startCommand);
  assert.ok(first.ok);
  if (first.ok) assert.equal(first.applied, true);
  const snapshot = buildSnapshot(sink.state());
  const resumed = LocalCommandSink.resume(snapshot);
  // The exact original command object — makeCommand mints fresh ids per call,
  // and the version check precedes idempotency, so a NEW command id would be
  // rejected as VERSION_CONFLICT instead of deduplicated.
  const replayed = await resumed.submit(startCommand);
  assert.ok(replayed.ok);
  if (replayed.ok) assert.equal(replayed.applied, false, 'processedCommandIds live in state, not in the sink');
  assert.deepEqual(resumed.state(), snapshot.state);
});

test('persistence: serializeSnapshot output parses back to the same snapshot', async () => {
  const { sink } = await startedSink();
  const snapshot: GameSnapshot = buildSnapshot(sink.state());
  const store = new LocalSnapshotStore(new MemoryStorage());
  storageSetRaw(store, serializeSnapshot(snapshot));
  assert.deepEqual(store.load(GAME_ID), snapshot);
});
