/**
 * Multiplayer contract §5 checklist (spec criterion 1) — one named test per
 * item of "What a Phase 2 server must preserve", each proven against the
 * live server over real sockets:
 *
 *   1. Every state change flows through `applyCommand` — no direct state writes.
 *   2. `canAct` is the authorization function — reused, not reimplemented.
 *   3. `expectedVersion` is checked on every submission (idempotent retries exempt).
 *   4. `commandId` applies exactly once; duplicates return the stored events.
 *   5. Event sequences stay gapless; `meta` carries results, never PRNG words.
 *   6. Snapshots are schema-gated; unknown versions refuse cleanly.
 *   7. Replay from `{ seed, ordered commands }` reproduces the state hash.
 *   8. The engine stays free of wall-clock, DOM, and ambient randomness.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import type { GameCommand } from '../../src/lib/game/commands';
import { createGame } from '../../src/lib/game/engine/reducer';
import { replayCommands, stateHash } from '../../src/lib/game/engine/replay';
import type { GameState, PlayerId } from '../../src/lib/game/types';
import { SOCKET_EVENTS } from '../../src/lib/game/transport/protocol';
import { hasKeyDeep, startHarness, type TestHarness } from './helpers';
import {
  assertGapless,
  eventStream,
  openRoom,
  playSingleTurn,
  submitFromSeat,
  waitForObserved,
  WireClient,
  type RoomFixture,
} from './wireDriver';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** Ambient nondeterminism the engine is forbidden to touch. */
const FORBIDDEN_PATTERNS = [
  'Date.now(',
  'new Date(',
  'performance.now',
  'Math.random',
  'setTimeout(',
  'setInterval(',
  'setImmediate(',
  'window.',
  'document.',
  'localStorage',
  'sessionStorage',
  'process.env',
] as const;

function scanEngineSources(): { file: string; pattern: string }[] {
  const engineDir = join(REPO_ROOT, 'src', 'lib', 'game', 'engine');
  const files = readdirSync(engineDir)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => join(engineDir, name));
  // The wire-facing envelope modules carry the boundary guarantees too.
  files.push(
    join(REPO_ROOT, 'src', 'lib', 'game', 'rng.ts'),
    join(REPO_ROOT, 'src', 'lib', 'game', 'commands.ts'),
    join(REPO_ROOT, 'src', 'lib', 'game', 'events.ts'),
  );
  const hits: { file: string; pattern: string }[] = [];
  for (const file of files) {
    const stripped = stripComments(readFileSync(file, 'utf8'));
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (stripped.includes(pattern)) hits.push({ file: file.replace(`${REPO_ROOT}/`, ''), pattern });
    }
  }
  return hits;
}

describe('Multiplayer contract §5 checklist (criterion 1)', () => {
  let harness: TestHarness;
  before(async () => {
    harness = await startHarness({
      commandLimit: { max: 1_000_000, windowMs: 10_000 },
      joinLimit: { max: 1_000_000, windowMs: 60_000 },
    });
  });
  after(() => harness.close());

  it('§5.1 — every state change flows through applyCommand: junk shapes refuse, no side doors, ledger accounts for every bump', { timeout: 60_000 }, async () => {
    const fixture: RoomFixture = await openRoom({ harness, mode: 'BLITZ', seatCount: 2 });
    const client = fixture.clients[0];
    const lobbyVersion = client.state.version;

    await submitFromSeat(fixture, 0, 'START_GAME', {}, 'checklist-51-start');
    const versionAfterStart = client.state.version;

    // An unknown command type never enters the pipeline.
    const garbage = await client.command(
      { commandId: 'checklist-51-garbage', gameId: fixture.gameId, actorId: 'p1', expectedVersion: versionAfterStart, type: 'SET_CASH', payload: { cash: 9_999_999 } } as never,
    );
    assert.ok(!garbage.ok, 'an unknown command type was accepted');
    assert.equal(garbage.error.code, 'INVALID_SHAPE');

    // A known envelope smuggling an undeclared payload key is refused — the
    // version check cannot be laundered through a payload side door.
    const smuggled = await client.command(
      { commandId: 'checklist-51-smuggled', gameId: fixture.gameId, actorId: 'p1', expectedVersion: versionAfterStart, type: 'SAVE_SNAPSHOT', payload: { cheat: true } } as never,
    );
    assert.ok(!smuggled.ok, 'an undeclared payload key was accepted');
    assert.equal(smuggled.error.code, 'INVALID_SHAPE');

    // Neither rejection moved state, and the version bump count equals the
    // applied-command ledger 1:1 — the ONLY writer is applyCommand.
    assert.equal(client.state.version, versionAfterStart);
    const ledger = harness.db.listAppliedCommands(fixture.gameId);
    assert.equal(client.state.version - lobbyVersion, ledger.length);
    assert.equal(ledger[0].type, 'START_GAME');
  });

  it('§5.2 — canAct is the authorization function: a forged actorId claim is dropped, not honored', { timeout: 60_000 }, async () => {
    const fixture = await openRoom({ harness, mode: 'BLITZ', seatCount: 2 });
    await submitFromSeat(fixture, 0, 'START_GAME', {}, 'checklist-52-start');
    const p2 = fixture.clients[1];

    // p2's authenticated session submits a command CLAIMING to be p1 — the
    // active player. The server must re-stamp identity from the session
    // before authorization; the claim must never reach canAct.
    const forged = await p2.command(
      { commandId: 'checklist-52-forged', gameId: fixture.gameId, actorId: 'p1', expectedVersion: p2.state.version, type: 'ROLL', payload: {} } as GameCommand,
    );
    assert.ok(!forged.ok, 'the forged claim was honored');
    assert.equal(forged.error.code, 'NOT_AUTHORIZED');
    assert.match(forged.error.message, /player p2 may not/, 'the rejection names the SESSION actor, not the claimed one');
    assert.doesNotMatch(forged.error.message, /player p1 may/);

    // The forged attempt did not consume the version: the genuine actor's
    // command at the SAME expectedVersion applies.
    const genuine = await submitFromSeat(fixture, 0, 'ROLL', {}, 'checklist-52-genuine');
    assert.ok(genuine.ok && genuine.applied, `the genuine actor's command was refused: ${JSON.stringify(genuine)}`);
  });

  it('§5.3 — expectedVersion is checked on every submission; idempotent retries are the only exemption', { timeout: 60_000 }, async () => {
    const fixture = await openRoom({ harness, mode: 'BLITZ', seatCount: 2 });
    const client = fixture.clients[0];
    const v0 = client.state.version;

    const start = { commandId: 'checklist-53-start', gameId: fixture.gameId, actorId: 'p1', expectedVersion: v0, type: 'START_GAME', payload: {} } as GameCommand;
    const first = await client.command(start);
    assert.ok(first.ok && first.applied, 'the opening command did not apply');
    const storedEvents = first.ok ? first.events : [];

    // A FRESH id at a stale version is refused.
    const stale = await client.command(
      { commandId: 'checklist-53-late', gameId: fixture.gameId, actorId: 'p1', expectedVersion: v0, type: 'SAVE_SNAPSHOT', payload: {} } as GameCommand,
    );
    assert.ok(!stale.ok, 'a fresh id at a stale version was accepted');
    assert.equal(stale.error.code, 'VERSION_CONFLICT');

    // The SAME id resubmitted with an absurd stale version is EXEMPT from
    // the version check and returns the stored events — the one carve-out,
    // exactly as contracted.
    const retry = await client.command({ ...start, expectedVersion: v0 + 100 } as GameCommand);
    assert.ok(retry.ok, 'the idempotent retry was rejected');
    assert.ok(!retry.applied, 'the idempotent retry re-applied');
    assert.deepEqual(retry.ok ? retry.events : [], storedEvents);
  });

  it('§5.4 — commandId applies exactly once; duplicates return the stored events', { timeout: 60_000 }, async () => {
    const fixture = await openRoom({ harness, mode: 'BLITZ', seatCount: 2 });
    const client = fixture.clients[0];
    const command = {
      commandId: 'checklist-54-once',
      gameId: fixture.gameId,
      actorId: 'p1',
      expectedVersion: client.state.version,
      type: 'START_GAME',
      payload: {},
    } as GameCommand;

    const first = await client.command(command);
    assert.ok(first.ok && first.applied, 'the first application failed');
    const storedEvents = first.ok ? first.events : [];

    for (let attempt = 0; attempt < 3; attempt++) {
      const duplicate = await client.command(command);
      assert.ok(duplicate.ok, `duplicate ${attempt + 1} was rejected: ${JSON.stringify(duplicate)}`);
      assert.ok(!duplicate.applied, `duplicate ${attempt + 1} re-applied`);
      assert.deepEqual(duplicate.applied ? [] : duplicate.events, storedEvents, `duplicate ${attempt + 1} returned different events`);
    }

    // Exactly one ledger row, exactly one version bump.
    const ledger = harness.db.listAppliedCommands(fixture.gameId).filter((row) => row.commandId === 'checklist-54-once');
    assert.equal(ledger.length, 1);
    assert.equal(client.state.version, command.expectedVersion + 1);
  });

  it('§5.5 — event sequences stay gapless; meta carries results, never PRNG words', { timeout: 60_000 }, async () => {
    const fixture = await openRoom({ harness, mode: 'BLITZ', seatCount: 2 });
    await submitFromSeat(fixture, 0, 'START_GAME', {}, 'checklist-55-start');
    await submitFromSeat(fixture, 0, 'ROLL', {}, 'checklist-55-roll');

    // One global order at every seat, gapless from 1.
    const reference = eventStream(fixture.clients[0].events);
    fixture.clients.forEach((client, seat) => {
      assert.deepEqual(eventStream(client.events), reference, `seat ${seat + 1} diverged`);
      assertGapless(client.events, `seat ${seat + 1}`);
    });
    assert.ok(reference.length >= 3, 'the scenario produced too few events to be meaningful');

    // No event — payloads, meta, anything — carries a PRNG word.
    for (const event of fixture.clients[0].events) {
      for (const key of ['seed', 'rngState', 'eventDeck']) {
        assert.equal(hasKeyDeep(event, key), false, `event ${event.sequence} (${event.type}) leaked "${key}"`);
      }
    }
  });

  it('§5.6 — snapshots are schema-gated; unknown versions refuse cleanly and neighbors stay healthy', { timeout: 120_000 }, async () => {
    // Own harness pair: this test restarts a server against the same file
    // and must not disturb the suite-level harness.
    const first = await startHarness({
      commandLimit: { max: 1_000_000, windowMs: 10_000 },
      joinLimit: { max: 1_000_000, windowMs: 60_000 },
    });
    // Two rooms share one SQLite file.
    const roomA = await openRoom({ harness: first, mode: 'BLITZ', seatCount: 2 });
    const roomB = await openRoom({ harness: first, mode: 'BLITZ', seatCount: 2 });
    first.close();

    // Corrupt room A's persisted snapshot to an unknown schema version.
    const bare = new Database(first.dbPath);
    const row = bare.prepare('SELECT state_snapshot FROM games WHERE game_id = ?').get(roomA.gameId) as { state_snapshot: string };
    const snapshot = JSON.parse(row.state_snapshot) as Record<string, unknown>;
    snapshot.schemaVersion = 999999;
    bare.prepare('UPDATE games SET state_snapshot = ? WHERE game_id = ?').run(JSON.stringify(snapshot), roomA.gameId);
    bare.close();

    const restarted = await startHarness({
      dbPath: first.dbPath,
      commandLimit: { max: 1_000_000, windowMs: 10_000 },
      joinLimit: { max: 1_000_000, windowMs: 60_000 },
    });
    try {
      // The join path refuses cleanly — a typed refusal, not a crash.
      const joiner = await WireClient.connect(restarted);
      const joinAck = (await restarted.ack(joiner.socket, SOCKET_EVENTS.join, {
        code: roomA.roomCode,
        name: 'Player 1',
        token: roomA.tokens[0],
      })) as { ok: false; error: { code: string; message: string } };
      assert.ok(!joinAck.ok, 'the unknown-version snapshot loaded');
      assert.equal(joinAck.error.code, 'STATE_LOAD_FAILED');

      // The command path refuses too, for a handshake-authed session of
      // that game — recovery never bypasses the schema gate. (The connect
      // auth argument IS the handshake auth record.)
      const authed = await WireClient.connect(restarted, { token: roomA.tokens[0] });
      const commandAck = (await restarted.ack(authed.socket, SOCKET_EVENTS.command, {
        commandId: 'checklist-56-command',
        gameId: roomA.gameId,
        actorId: 'p1',
        expectedVersion: 999999,
        type: 'SAVE_SNAPSHOT',
        payload: {},
      })) as { ok: false; error: { code: string; message: string } };
      assert.ok(!commandAck.ok, 'a command forced the corrupt game through recovery');
      assert.equal(commandAck.error.code, 'STATE_LOAD_FAILED');

      // The sibling game in the same file is untouched: join and act.
      const healthy = await WireClient.connect(restarted);
      const healthyJoin = (await restarted.ack(healthy.socket, SOCKET_EVENTS.join, {
        code: roomB.roomCode,
        name: 'Player 1',
        token: roomB.tokens[0],
      })) as { ok: true };
      assert.ok(healthyJoin.ok, 'the healthy sibling game refused a join');
      await healthy.waitForVersion(0);
      const save = await healthy.command(
        { commandId: 'checklist-56-healthy', gameId: roomB.gameId, actorId: 'p1', expectedVersion: healthy.state.version, type: 'SAVE_SNAPSHOT', payload: {} } as GameCommand,
      );
      assert.ok(save.ok && save.applied, `the healthy sibling could not act: ${JSON.stringify(save)}`);
    } finally {
      restarted.close();
    }
  });

  it('§5.7 — replay from { seed, ordered commands } reproduces the state hash', { timeout: 120_000 }, async () => {
    const fixture = await openRoom({ harness, mode: 'BLITZ', seatCount: 2 });
    await submitFromSeat(fixture, 0, 'START_GAME', {}, 'checklist-57-start');
    // Two real profile-driven turns so the ledger carries more than a
    // trivial shape.
    for (let turn = 0; turn < 2; turn++) {
      await waitForObserved(fixture.clients[0], (s) => s.phase === 'PLAYING' && s.turnPhase === 'AWAITING_ROLL', 'a turn to start');
      const seat = fixture.playerIds.indexOf(fixture.clients[0].state.activePlayerId as PlayerId);
      await playSingleTurn(fixture, seat);
    }

    const ledger = harness.db.listAppliedCommands(fixture.gameId);
    assert.ok(ledger.length > 2, 'the scenario produced too little history to be meaningful');
    const snapshot = harness.db.loadSnapshot(fixture.gameId);
    assert.ok(snapshot);
    const created = createGame({ gameId: fixture.gameId, seed: snapshot.seed, playerIds: [...fixture.playerIds], mode: fixture.mode });
    assert.ok(created.ok);
    const folded = replayCommands(created.state, ledger);
    assert.equal(folded.appliedCount, ledger.length, 'a ledger row did not reapply during replay');
    assert.equal(stateHash(folded.state as GameState), stateHash(snapshot.state), 'replay diverged from the server state');
  });

  it('§5.8 — the engine stays free of wall-clock, DOM, and ambient randomness (static scan)', () => {
    // The scanner must be able to fail: a dirty source lights it up.
    const dirty = stripComments('const t = /* comment hides nothing */ Date.now(); // Math.random in a comment\nconst r = Math.random();');
    assert.ok(dirty.includes('Date.now('), 'the scanner is blind to Date.now');
    assert.ok(dirty.includes('Math.random'), 'the scanner is blind to Math.random');

    const hits = scanEngineSources();
    assert.deepEqual(
      hits,
      [],
      `engine purity violated (wall-clock / DOM / ambient randomness in the engine):\n${hits.map((hit) => `${hit.file}: ${hit.pattern}`).join('\n')}`,
    );
  });
});
