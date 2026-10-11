/**
 * The network sink and event source (spec criterion 3 over the wire):
 * against the real gateway — idempotent retries, version conflicts, forged
 * identity claims, redaction-free acks — and against a bare socket.io server
 * for the client-side paths the gateway cannot produce (ack timeout, a gapped
 * event stream).
 *
 * Version trace for the shared room: a fresh room's engine state is at
 * version 0; each applied command bumps it. The reducer exempts
 * already-processed commandIds from the version check, so the idempotent
 * retry resubmits its ORIGINAL envelope.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { Server as SocketIoServer } from 'socket.io';
import { io as createClient, type Socket as ClientSocket } from 'socket.io-client';
import { startHarness, type TestHarness } from '../server/helpers';
import { SOCKET_EVENTS, type RoomAck, type WireCommandResult } from '../../src/lib/game/transport/protocol';
import { EventGapError, NetworkCommandSink, SocketEventSource } from '../../src/lib/game/transport/networkSink';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('NetworkCommandSink + SocketEventSource (real gateway)', () => {
  let harness: TestHarness;
  let socket: ClientSocket;
  let gameId: string;
  let actorId: string;
  let version: number;

  before(async () => {
    harness = await startHarness();
    const raw = await harness.connect();
    const ack = await harness.ack<RoomAck>(raw, SOCKET_EVENTS.create, { mode: 'CLASSIC', seatCount: 2, name: 'Ada' });
    assert.ok(ack.ok, `create must succeed: ${JSON.stringify(ack)}`);
    gameId = ack.gameId;
    actorId = ack.actorId;
    version = 0; // a fresh room's engine state version
    socket = raw;
  });
  after(async () => {
    await harness.close();
  });

  it('an applied command acks ok with events and no server state (wire purity)', async () => {
    const sink = new NetworkCommandSink(socket);
    const result = (await sink.submit({
      commandId: 'c-start-1',
      gameId,
      actorId,
      expectedVersion: version,
      type: 'START_GAME',
      payload: {},
    } as never)) as WireCommandResult;
    assert.ok(result.ok, `expected ok: ${JSON.stringify(result)}`);
    assert.equal(result.applied, true);
    assert.ok(result.events.length > 0, 'an applied command acks its event batch');
    assert.ok(!('state' in result), 'the ack must not carry authoritative state');
    version += 1;
  });

  it('a duplicate commandId acks applied:false with the stored events', async () => {
    const sink = new NetworkCommandSink(socket);
    // The exact envelope from the previous test — original expectedVersion.
    const replay = (await sink.submit({
      commandId: 'c-start-1',
      gameId,
      actorId,
      expectedVersion: 0,
      type: 'START_GAME',
      payload: {},
    } as never)) as WireCommandResult;
    assert.ok(replay.ok, 'a ledgered retry still succeeds');
    assert.equal(replay.applied, false, 'but does not apply twice');
    assert.ok(replay.events.length > 0, 'and returns the stored events from the ledger');
  });

  it('a stale expectedVersion acks VERSION_CONFLICT', async () => {
    const sink = new NetworkCommandSink(socket);
    const result = (await sink.submit({
      commandId: 'c-stale-1',
      gameId,
      actorId,
      expectedVersion: 999,
      type: 'START_GAME',
      payload: {},
    } as never)) as WireCommandResult;
    assert.ok(!result.ok);
    assert.equal(result.error.code, 'VERSION_CONFLICT');
  });

  it('a forged actorId claim is dropped — the session stamp applies', async () => {
    const sink = new NetworkCommandSink(socket);
    // If the forged claim were honored, the command would be rejected
    // (UNKNOWN_PLAYER — the forger is not in the game). Applying proves the
    // stamp won: the session's actor is the active player, so ROLL is legal.
    const result = (await sink.submit({
      commandId: 'c-forge-1',
      gameId,
      actorId: 'p-evil',
      expectedVersion: version,
      type: 'ROLL',
      payload: {},
    } as never)) as WireCommandResult;
    assert.ok(result.ok, `expected the stamped actor's ROLL to be legal: ${JSON.stringify(result)}`);
    assert.equal(result.applied, true);
  });

  it('the event source sees broadcast events in stamped order (own room)', async () => {
    const raw = await harness.connect();
    // Subscribe BEFORE creating: the create ack is preceded by the room's
    // first events (create-time catch-up), so a late subscriber misses them
    // and the gapless check correctly flags the jump.
    const source = new SocketEventSource(raw);
    const seen: number[] = [];
    const ack = await harness.ack<RoomAck>(raw, SOCKET_EVENTS.create, { mode: 'CLASSIC', seatCount: 2, name: 'Grace' });
    assert.ok(ack.ok, `create must succeed: ${JSON.stringify(ack)}`);
    const freshGameId = ack.gameId;
    source.subscribe(freshGameId, 1, (event) => seen.push(event.sequence));
    const sink = new NetworkCommandSink(raw);
    const result = (await sink.submit({
      commandId: 'c-start-fresh',
      gameId: freshGameId,
      actorId: ack.actorId,
      expectedVersion: 0,
      type: 'START_GAME',
      payload: {},
    } as never)) as WireCommandResult;
    assert.ok(result.ok, `START_GAME must apply: ${JSON.stringify(result)}`);
    await sleep(300); // let the broadcast land

    assert.ok(seen.length > 0, 'the source must receive the broadcast event');
    for (let i = 1; i < seen.length; i += 1) {
      assert.equal(seen[i], seen[i - 1]! + 1, 'delivered sequences stay gapless');
    }
    assert.equal(source.lastSeenSeq(freshGameId), seen.at(-1), 'lastSeenSeq tracks the last delivered event');
  });
});

describe('client-side transport faults (bare socket.io server)', () => {
  const httpServer = createServer();
  const io = new SocketIoServer(httpServer);
  // Accept connections but never ack commands — the timeout path. The
  // 'game:hello' trigger emits a crafted gapped stream (seq 2 arrives first;
  // seq 1 never does) for the event-source test.
  io.on('connection', (client) => {
    client.on('game:hello', () => {
      client.emit(SOCKET_EVENTS.event, { gameId: 'g-gap', sequence: 2, type: 'IMPOSSIBLE' });
    });
  });
  let port = 0;

  before(async () => {
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
    port = (httpServer.address() as { port: number }).port;
  });
  after(async () => {
    io.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it('a missing ack resolves with ACK_TIMEOUT (the sink never rejects)', async () => {
    const client = createClient(`http://127.0.0.1:${port}`, { transports: ['websocket'], forceNew: true });
    await new Promise<void>((resolve) => client.on('connect', resolve));
    const sink = new NetworkCommandSink(client, 300);
    const result = await sink.submit({ commandId: 'c-1', type: 'PASS' } as never);
    assert.ok(!result.ok);
    assert.equal(result.error.code, 'ACK_TIMEOUT');
    client.disconnect();
  });

  it('a gapped event stream is skipped and reported via onGap', async () => {
    const client = createClient(`http://127.0.0.1:${port}`, { transports: ['websocket'], forceNew: true });
    await new Promise<void>((resolve) => client.on('connect', resolve));
    const gaps: EventGapError[] = [];
    const source = new SocketEventSource(client, (error) => gaps.push(error));
    const delivered: number[] = [];
    source.subscribe('g-gap', 1, (event) => delivered.push(event.sequence));
    client.emit('game:hello');
    await sleep(300);
    assert.deepEqual(delivered, [], 'a gapped event must not be delivered');
    assert.equal(gaps.length, 1, 'the gap must be reported exactly once');
    assert.equal(gaps[0]!.expected, 1);
    assert.equal(gaps[0]!.received, 2);
    assert.equal(source.lastSeenSeq('g-gap'), 0, 'the gapped event advances nothing');
    client.disconnect();
  });
});
