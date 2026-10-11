/**
 * The online client (OnlineGameClient) against the REAL gateway harness —
 * no mocks (spec criterion 5/6 client-side): first join mints a session,
 * reconnect re-auths with the token and catches up from the last seen
 * sequence, and room refusals reject the connect promise with the pinned
 * fault codes.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { io as createClient, type Socket as ClientSocket } from 'socket.io-client';
import { startHarness, type TestHarness } from '../server/helpers';
import { SOCKET_EVENTS, type RoomAck } from '../../src/lib/game/transport/protocol';
import type { WireCommandResult, RosterEntry } from '../../src/lib/game/transport/protocol';
import type { ClientGameState } from '../../src/lib/game/transport/clientState';
import type { TransportFault } from '../../src/lib/game/transport/networkSink';
import {
  OnlineGameClient,
  WireFaultError,
  type ConnectionState,
  type OnlineClientCallbacks,
  type OnlineSessionRecord,
} from '../../src/lib/game/transport/onlineClient';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll until the condition holds or the budget runs out (reconnect timing is async). */
async function until(what: string, condition: () => boolean, budgetMs = 5000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

/** Every callback of the client, recorded in order for assertions. */
function collector(): {
  rosters: (readonly RosterEntry[])[];
  states: ClientGameState[];
  faults: TransportFault[];
  connections: ConnectionState[];
  callbacks: OnlineClientCallbacks;
} {
  const rosters: (readonly RosterEntry[])[] = [];
  const states: ClientGameState[] = [];
  const faults: TransportFault[] = [];
  const connections: ConnectionState[] = [];
  return {
    rosters,
    states,
    faults,
    connections,
    callbacks: {
      onRoster: (roster) => rosters.push(roster),
      onState: (state) => states.push(state),
      onFault: (fault) => faults.push(fault),
      onConnection: (state) => connections.push(state),
      onEvent: () => {},
    },
  };
}

function harnessFactory(harness: TestHarness): () => ClientSocket {
  return () => createClient(`http://127.0.0.1:${harness.port}`, { transports: ['websocket'], forceNew: true });
}

/** A room with one seated creator, via the raw harness socket. */
async function createRoom(harness: TestHarness, name: string, seatCount = 2): Promise<OnlineSessionRecord> {
  const socket = await harness.connect();
  const ack = await harness.ack<RoomAck>(socket, SOCKET_EVENTS.create, { mode: 'CLASSIC', seatCount, name });
  assert.ok(ack.ok, 'create room ack must succeed');
  return {
    token: ack.token,
    gameId: ack.gameId,
    roomCode: ack.roomCode,
    actorId: ack.actorId,
    name,
  };
}

describe('OnlineGameClient (real gateway)', () => {
  let harness: TestHarness;

  before(async () => {
    // The suite drives many joins through one harness IP — the published
    // 5-joins-per-minute budget would trip itself. Generous budgets keep the
    // limiter tests where they belong: in the server suites.
    harness = await startHarness({
      commandLimit: { max: 1000, windowMs: 10_000 },
      joinLimit: { max: 1000, windowMs: 60_000 },
    });
  });
  after(async () => {
    await harness.close();
  });

  it('first join mints a session, reports the roster, and goes live', async () => {
    const room = await createRoom(harness, 'Ada', 2);
    const observed = collector();
    const client = await OnlineGameClient.connect(
      { code: room.roomCode, name: 'Bea', socketFactory: harnessFactory(harness) },
      observed.callbacks,
    );
    try {
      const session = client.getSession();
      assert.ok(session !== null, 'a fresh join must mint a session');
      assert.equal(session.roomCode, room.roomCode);
      assert.notEqual(session.actorId, room.actorId, 'Bea claims her own seat');
      assert.match(session.token, /^[0-9a-f]{64}$/, 'server-minted 32-byte hex token');
      assert.equal(client.connectionState, 'live');
      assert.ok(observed.rosters.length > 0);
      assert.deepEqual(
        observed.rosters.at(-1)!.map((entry) => entry.name).sort(),
        ['Ada', 'Bea'],
      );
      assert.equal(observed.faults.length, 0, `unexpected faults: ${JSON.stringify(observed.faults)}`);
    } finally {
      client.close();
    }
  });

  it('an unknown room code rejects the connect promise with ROOM_NOT_FOUND', async () => {
    await assert.rejects(
      OnlineGameClient.connect(
        { code: 'ZZ4ZZZ', name: 'Bea', socketFactory: harnessFactory(harness) },
        collector().callbacks,
      ),
      (error: unknown) => error instanceof WireFaultError && error.fault.code === 'ROOM_NOT_FOUND',
    );
  });

  it('a late fresh join after the game starts rejects with ROOM_IN_PROGRESS', async () => {
    const room = await createRoom(harness, 'Ada', 2);
    const observed = collector();
    const host = await OnlineGameClient.connect(
      { code: room.roomCode, name: 'Ada', session: room, socketFactory: harnessFactory(harness) },
      observed.callbacks,
    );
    try {
      const start = (await host.sink.submit({
        commandId: `start-${Date.now()}`,
        gameId: room.gameId,
        actorId: room.actorId,
        expectedVersion: observed.states.at(-1)?.version ?? 0,
        type: 'START_GAME',
        payload: {},
      } as never)) as WireCommandResult;
      assert.ok(start.ok, `START_GAME must apply: ${JSON.stringify(start)}`);

      await assert.rejects(
        OnlineGameClient.connect(
          { code: room.roomCode, name: 'Cleo', socketFactory: harnessFactory(harness) },
          collector().callbacks,
        ),
        (error: unknown) => error instanceof WireFaultError && error.fault.code === 'ROOM_IN_PROGRESS',
      );
    } finally {
      host.close();
    }
  });

  it('a dead token rejects with INVALID_SESSION', async () => {
    const room = await createRoom(harness, 'Ada', 2);
    const ghost: OnlineSessionRecord = { ...room, token: 'dead'.repeat(16) };
    await assert.rejects(
      OnlineGameClient.connect(
        { code: room.roomCode, name: 'Ada', session: ghost, socketFactory: harnessFactory(harness) },
        collector().callbacks,
      ),
      (error: unknown) => error instanceof WireFaultError && error.fault.code === 'INVALID_SESSION',
    );
  });

  it('disconnect mid-lobby → auto-reconnect re-auths with the token, no faults', async () => {
    const room = await createRoom(harness, 'Ada', 2);
    let clientSocket: ClientSocket | null = null;
    const observed = collector();
    const client = await OnlineGameClient.connect(
      {
        code: room.roomCode,
        name: 'Bea',
        socketFactory: () => {
          clientSocket = harnessFactory(harness)();
          return clientSocket;
        },
      },
      observed.callbacks,
    );
    try {
      const tokenBefore = client.getSession()!.token;

      // Server-side drop: the client's auto-reconnect must re-auth silently.
      // The connections trace is append-only, so "reconnecting" recorded +
      // live again is observable without racing the fast recovery.
      harness.io.sockets.sockets.get(clientSocket!.id!)?.disconnect(true);
      await until(
        'the reconnect to complete (drop observed, then live again)',
        () => observed.connections.includes('reconnecting') && client.connectionState === 'live',
        10_000,
      );

      assert.equal(client.getSession()!.token, tokenBefore, 're-auth reuses the stored token');
      assert.equal(observed.faults.length, 0, `unexpected faults: ${JSON.stringify(observed.faults)}`);
      assert.ok(
        observed.connections.includes('reconnecting'),
        `connection trace should include reconnecting: ${observed.connections.join(',')}`,
      );
    } finally {
      client.close();
    }
  });

  it('disconnect before START_GAME → reconnect catches up with the missed events, gapless', async () => {
    const room = await createRoom(harness, 'Ada', 2);
    let clientSocket: ClientSocket | null = null;
    const observed = collector();
    const client = await OnlineGameClient.connect(
      {
        code: room.roomCode,
        name: 'Bea',
        socketFactory: () => {
          clientSocket = harnessFactory(harness)();
          return clientSocket;
        },
      },
      observed.callbacks,
    );

    // Bea's event tap — every delivered event, in order.
    const gameId = client.getSession()!.gameId;
    const seen: string[] = [];
    client.events.subscribe(gameId, 1, (event) => seen.push(`${event.sequence}:${event.type}`));

    // Take Bea down deliberately: a client-side disconnect performs no
    // reconnection attempts, so the offline window is deterministic. While
    // she is away, the host starts the game.
    clientSocket!.disconnect();
    await until('Bea to go down', () => client.connectionState !== 'live', 2000);
    const hostObserved = collector();
    const host = await OnlineGameClient.connect(
      { code: room.roomCode, name: 'Ada', session: room, socketFactory: harnessFactory(harness) },
      hostObserved.callbacks,
    );
    try {
      const start = (await host.sink.submit({
        commandId: `start-${Date.now()}`,
        gameId: room.gameId,
        actorId: room.actorId,
        expectedVersion: hostObserved.states.at(-1)?.version ?? 0,
        type: 'START_GAME',
        payload: {},
      } as never)) as WireCommandResult;
      assert.ok(start.ok, `START_GAME must apply: ${JSON.stringify(start)}`);

      // Bea returns: one deliberate reconnect — re-auth with the token and
      // catch-up from lastSeen + 1 must deliver the events she missed. The
      // tap subscribed after her first join, so its window holds exactly the
      // missed events: any delivery proves the catch-up path ran.
      clientSocket!.connect();
      await until('Bea to come back live', () => client.connectionState === 'live', 10_000);
      await until('Bea to catch up on the missed events', () => seen.length > 0, 10_000);

      const seqs = seen.map((entry) => Number.parseInt(entry.split(':')[0] ?? '0', 10));
      for (let i = 1; i < seqs.length; i += 1) {
        assert.equal(seqs[i], seqs[i - 1]! + 1, `gapless delivery violated at ${seen[i - 1]} → ${seen[i]}`);
      }
      assert.equal(observed.faults.length, 0, `unexpected faults: ${JSON.stringify(observed.faults)}`);
      const lastState = observed.states.at(-1);
      assert.ok(lastState !== undefined, 'reconnect must re-broadcast state');
      assert.equal(lastState.phase, 'PLAYING', 'catch-up state must show the started game');
    } finally {
      client.close();
      host.close();
    }
  });
});
