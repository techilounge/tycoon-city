/**
 * §17.3 probes over the wire (spec criterion 3): the sim driver's probe
 * skeleton pointed at the real gateway. (a) forged actor → NOT_AUTHORIZED,
 * state untouched; (b) stale expectedVersion → VERSION_CONFLICT, state
 * untouched; (c) duplicate commandId → ok/applied:false with the stored
 * events of the original application; (d) {seed, ordered commands} replay →
 * identical hash. The restart leg of (c) lives in durability.test.ts.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { stateHash } from '../../src/lib/game/engine/replay';
import type { GameCommand } from '../../src/lib/game/commands';
import { startHarness, type TestHarness } from './helpers';
import { openRoom, runNetworkedGame, WireClient, type RoomFixture } from './wireDriver';
import { SOCKET_EVENTS, type SessionAck } from '../../src/lib/game/transport/protocol';

describe('17.3 conformance over the wire (criterion 3)', () => {
  let harness: TestHarness;
  before(async () => {
    harness = await startHarness({
      commandLimit: { max: 1_000_000, windowMs: 10_000 },
      joinLimit: { max: 1_000_000, windowMs: 60_000 },
    });
  });
  after(() => harness.close());

  it('drives a complete BLITZ game with probes (a)-(c) interleaved and (d) verified at the end', { timeout: 300_000 }, async () => {
    const fixture = await openRoom({ harness, mode: 'BLITZ', seatCount: 2 });
    const result = await runNetworkedGame(fixture, serverHashOf(fixture));

    assert.ok(result.demonstration.allGreen, `probes not all green: ${JSON.stringify(result.demonstration)}`);
    assert.ok(result.demonstration.unauthorizedActorRejections >= 1);
    assert.ok(result.demonstration.staleVersionRejections >= 1);
    assert.ok(result.demonstration.idempotentReplays >= 1);
    assert.equal(result.demonstration.replayFullHashMatchesServer, true);
    // A complete game submitted a meaningful number of commands.
    assert.ok(result.appliedCommands > 10, `game too short: ${result.appliedCommands} applied`);
  });

  it('probe (c) returns the stored events of the original application over the wire', { timeout: 60_000 }, async () => {
    const fixture = await openRoom({ harness, mode: 'BLITZ', seatCount: 2 });
    const client = fixture.clients[0];

    const start = {
      commandId: 'conf-start-1',
      gameId: fixture.gameId,
      actorId: 'p1',
      expectedVersion: client.state.version,
      type: 'START_GAME',
      payload: {},
    } as GameCommand;
    const first = (await client.command(start)) as { ok: boolean; applied: boolean; events: unknown[] };
    assert.equal(first.ok, true);
    assert.equal(first.applied, true);
    assert.ok(first.events.length >= 1);

    // Verbatim resubmission: ok + applied:false, and the SAME events come
    // back from the server's stored-events ledger (contract §2.4).
    const second = (await client.command(start)) as { ok: boolean; applied: boolean; events: unknown[] };
    assert.equal(second.ok, true);
    assert.equal(second.applied, false);
    assert.deepEqual(second.events, first.events);
  });

  it('probe (c) across a disconnect: a pre-disconnect commandId resubmits to the stored events (criterion 3)', { timeout: 60_000 }, async () => {
    const fixture = await openRoom({ harness, mode: 'BLITZ', seatCount: 2 });
    const client = fixture.clients[0];

    const start = {
      commandId: 'conf-dc-start-1',
      gameId: fixture.gameId,
      actorId: 'p1',
      expectedVersion: client.state.version,
      type: 'START_GAME',
      payload: {},
    } as GameCommand;
    const first = (await client.command(start)) as { ok: true; applied: true; events: unknown[] };
    assert.equal(first.applied, true);
    assert.ok(first.events.length >= 1);

    // The transport dies mid-retry: the client never learns whether the
    // command landed. On a fresh socket, re-authenticated by token, the
    // client replays the identical envelope.
    const fromSeq = Math.max(...client.events.map((event) => event.sequence));
    client.socket.disconnect();
    const fresh = await WireClient.connect(harness);
    const joinAck = (await harness.ack(fresh.socket, SOCKET_EVENTS.join, {
      code: fixture.roomCode,
      name: 'Player 1',
      token: fixture.tokens[0],
      fromSeq,
    })) as SessionAck | { ok: false; error: { code: string; message: string } };
    if (!joinAck.ok) throw new Error(`re-authentication failed: ${JSON.stringify(joinAck)}`);
    assert.equal(joinAck.actorId, 'p1', 'the token re-authenticated as a different actor');
    await fresh.waitForVersion(client.state.version);

    const retry = await fresh.command(start);
    assert.ok(retry.ok, `the replayed command was rejected: ${JSON.stringify(retry)}`);
    assert.ok(!retry.applied, 'the replayed command re-applied after a disconnect');
    assert.deepEqual(retry.ok ? retry.events : [], first.events, 'the replayed events differ from the original application');

    // Nothing moved: same version, one ledger row.
    assert.equal(fresh.state.version, client.state.version);
    const ledger = harness.db.listAppliedCommands(fixture.gameId).filter((row) => row.commandId === 'conf-dc-start-1');
    assert.equal(ledger.length, 1);
  });

  /** Operator privilege: the authoritative full-state hash of the game's latest snapshot. */
  function serverHashOf(fixture: RoomFixture): () => string {
    return () => {
      const snapshot = harness.db.loadSnapshot(fixture.gameId);
      if (snapshot === null) throw new Error(`no snapshot for ${fixture.gameId}`);
      return stateHash(snapshot.state);
    };
  }
});
