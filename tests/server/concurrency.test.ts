/**
 * Concurrency matrix (spec criterion 5): N clients race submissions on ONE
 * room over real sockets. The per-game queue must serialize every submission
 * — player commands and the races between them — so that:
 *
 *   • exactly one of a racing set applies per version bump (no double
 *     application, no lost updates — the applied-command ledger accounts for
 *     every version bump, with strictly consecutive expectedVersions);
 *   • duplicate commandIds racing together apply exactly once and every
 *     racing ack sees the SAME stored events;
 *   • every seat observes the identical, gapless event stream (one global
 *     order for the whole room);
 *   • the ledger refolds from { seed, ordered commands } to the server's
 *     authoritative state hash (no writes outside applyCommand).
 *
 * The engine's own pipeline (version gate, idempotency, authorization) is
 * what makes the outcomes legal; this suite proves the SERVER upholds those
 * semantics under concurrency rather than interleaving state.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { GameCommand } from '../../src/lib/game/commands';
import { createGame } from '../../src/lib/game/engine/reducer';
import { replayCommands, stateHash } from '../../src/lib/game/engine/replay';
import type { GameState } from '../../src/lib/game/types';
import { startHarness, type TestHarness } from './helpers';
import {
  assertGapless,
  eventStream,
  openRoom,
  submitFromSeat,
  WireClient,
  type RoomFixture,
} from './wireDriver';

/** Codes a racing command can legitimately be rejected with on this surface. */
const RACE_REJECTION_CODES = new Set(['VERSION_CONFLICT', 'NOT_AUTHORIZED', 'INVALID_PHASE']);

describe('concurrency — N clients racing on one room (criterion 5)', () => {
  let harness: TestHarness;
  before(async () => {
    harness = await startHarness({
      commandLimit: { max: 1_000_000, windowMs: 10_000 },
      joinLimit: { max: 1_000_000, windowMs: 60_000 },
    });
  });
  after(() => harness.close());

  it('the same commandId fired by 4 clients at once applies exactly once; every racer sees the same stored events', { timeout: 60_000 }, async () => {
    const fixture = await openRoom({ harness, mode: 'BLITZ', seatCount: 4 });
    const lobbyVersion = fixture.clients[0].state.version;

    // One envelope, four sockets, zero coordination.
    const shared: GameCommand = {
      commandId: 'race-identical-1',
      gameId: fixture.gameId,
      actorId: 'p1',
      expectedVersion: lobbyVersion,
      type: 'START_GAME',
      payload: {},
    };
    const acks = await Promise.all(fixture.clients.map((client) => client.command(shared)));

    // Exactly one application; the other three are idempotent no-ops that
    // return the stored events of the original application.
    const appliedAcks = acks.filter((ack) => ack.ok && ack.applied);
    assert.equal(appliedAcks.length, 1, `expected exactly one applied ack, got ${appliedAcks.length}`);
    const winner = appliedAcks[0];
    if (!winner.ok) throw new Error('unreachable');
    const storedEvents = winner.events;
    for (const ack of acks) {
      assert.ok(ack.ok, `a racing duplicate was rejected: ${JSON.stringify(ack)}`);
      if (!ack.applied) assert.deepEqual(ack.events, storedEvents, 'a racing duplicate saw different stored events');
    }

    // The version advanced exactly once, everywhere.
    await Promise.all(fixture.clients.map((client) => client.waitForVersion(lobbyVersion + 1)));
    for (const client of fixture.clients) assert.equal(client.state.version, lobbyVersion + 1);

    // The ledger holds exactly one application.
    const ledger = harness.db.listAppliedCommands(fixture.gameId);
    assert.equal(ledger.filter((command) => command.commandId === 'race-identical-1').length, 1);

    // One global order: every seat saw the identical gapless stream.
    const reference = eventStream(fixture.clients[0].events);
    fixture.clients.forEach((client, seat) => {
      assert.deepEqual(eventStream(client.events), reference, `client ${seat + 1} diverged`);
    });
    assertGapless(fixture.clients[0].events, 'same-command storm');
  });

  it('a mixed storm of distinct commands races cleanly: serialized applications, gapless order, no lost updates', { timeout: 120_000 }, async () => {
    const fixture: RoomFixture = await openRoom({ harness, mode: 'BLITZ', seatCount: 4 });
    const clients = fixture.clients;

    // Open the game (sequential), then storm.
    await submitFromSeat(fixture, 0, 'START_GAME', {}, 'race-mixed-start');
    const startVersion = clients[0].state.version;

    const appliedIds: string[] = [];
    let appliedCount = 0;
    const ROUNDS = 5;
    for (let round = 0; round < ROUNDS; round++) {
      // Every seat composes at the same freshly-observed version — a true race.
      const roundVersion = clients[0].state.version;
      await Promise.all(clients.map((client) => client.waitForVersion(roundVersion)));

      const races: Promise<{ seat: number; kind: string; result: Awaited<ReturnType<WireClient['command']>> }>[] = [];
      for (let seat = 0; seat < clients.length; seat++) {
        races.push(
          clients[seat]
            .command({
              commandId: `race-mixed-${round}-snap-${seat}`,
              gameId: fixture.gameId,
              actorId: fixture.playerIds[seat] as string,
              expectedVersion: roundVersion,
              type: 'SAVE_SNAPSHOT',
              payload: {},
            })
            .then((result) => ({ seat, kind: 'SAVE_SNAPSHOT', result })),
        );
        races.push(
          clients[seat]
            .command({
              commandId: `race-mixed-${round}-roll-${seat}`,
              gameId: fixture.gameId,
              actorId: fixture.playerIds[seat] as string,
              expectedVersion: roundVersion,
              type: 'ROLL',
              payload: {},
            })
            .then((result) => ({ seat, kind: 'ROLL', result })),
        );
      }

      const settled = await Promise.all(races);
      let roundApplied = 0;
      for (const { seat, kind, result } of settled) {
        if (result.ok && result.applied) {
          roundApplied += 1;
          appliedCount += 1;
          appliedIds.push(`race-mixed-${round}-${kind === 'ROLL' ? 'roll' : 'snap'}-${seat}`);
        } else if (result.ok) {
          assert.fail(`unexpected idempotent ack in a distinct-id storm: ${JSON.stringify(result)}`);
        } else {
          assert.ok(
            RACE_REJECTION_CODES.has(result.error.code),
            `racing command rejected with a non-race code: ${result.error.code} (${result.error.message})`,
          );
        }
      }
      // A SAVE_SNAPSHOT is legal for any live player in any phase, so at
      // least one command per round must land.
      assert.ok(roundApplied >= 1, `round ${round} applied nothing`);
      await Promise.all(clients.map((client) => client.waitForVersion(roundVersion + roundApplied)));
    }

    // No lost updates, part 1: version accounting. Every version bump
    // corresponds to exactly one applied command.
    assert.equal(clients[0].state.version, startVersion + appliedCount);

    // No lost updates, part 2: the ledger IS the application history, in
    // application order, with strictly consecutive expectedVersions — the
    // serialization proof. (Pre-start creation rows included, the chain runs
    // from the game's first version to its last without a gap.)
    const ledger = harness.db.listAppliedCommands(fixture.gameId);
    assert.equal(ledger.length, appliedCount + 1); // + the opening START_GAME
    assert.equal(new Set(ledger.map((command) => command.commandId)).size, ledger.length, 'a commandId applied twice');
    for (const id of appliedIds) {
      assert.equal(ledger.filter((command) => command.commandId === id).length, 1, `${id} missing from the ledger`);
    }
    ledger.forEach((command, index) => {
      assert.equal(
        command.expectedVersion,
        index,
        `ledger row ${index} (${command.type}) was composed against version ${command.expectedVersion} — the chain broke`,
      );
    });

    // Replay: the ledger refolds from the seed to the authoritative hash.
    const snapshot = harness.db.loadSnapshot(fixture.gameId);
    assert.ok(snapshot);
    const created = createGame({ gameId: fixture.gameId, seed: snapshot.seed, playerIds: [...fixture.playerIds], mode: fixture.mode });
    assert.ok(created.ok);
    const folded = replayCommands(created.state, ledger);
    assert.equal(folded.appliedCount, ledger.length);
    assert.equal(stateHash(folded.state as GameState), stateHash(snapshot.state), 'replay diverged from the server state');

    // One global order: identical, gapless streams at every seat.
    const reference = eventStream(clients[0].events);
    clients.forEach((client, seat) => {
      assert.deepEqual(eventStream(client.events), reference, `client ${seat + 1} diverged`);
    });
    assertGapless(clients[0].events, 'mixed storm');
  });
});
