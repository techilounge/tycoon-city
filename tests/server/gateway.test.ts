import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Server as SocketIoServer } from 'socket.io';
import { io as createClient, type Socket as ClientSocket } from 'socket.io-client';
import type { GameCommand } from '../../src/lib/game/commands';
import type { AnyGameEvent } from '../../src/lib/game/events';
import type { WireCommandResult } from '../../src/lib/game/transport/protocol';
import { TycoonDb } from '../../server/db';
import { GameHost } from '../../server/game/gameHost';
import { setupGateway } from '../../server/gateway';

const SEED = 0x5eed1234;

interface Harness {
  readonly port: number;
  readonly db: TycoonDb;
  makeGame(gameId: string): { gameId: string; roomCode: string; version: number };
  makeSession(gameId: string, actorId: string): string;
  connect(auth?: Record<string, unknown>): Promise<ClientSocket>;
  close(): Promise<void>;
}

function ackOf(socket: ClientSocket, command: unknown, event = 'game:command'): Promise<WireCommandResult> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ack timeout')), 5_000);
    socket.emit(event, command, (result: WireCommandResult) => {
      clearTimeout(timer);
      resolve(result);
    });
  });
}

function nextEvent<T>(socket: ClientSocket, event: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), 5_000);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

/** True when a key with exactly this name appears anywhere in the payload tree. */
function hasKeyDeep(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((v) => hasKeyDeep(v, key));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).some(([k, v]) => k === key || hasKeyDeep(v, key));
  }
  return false;
}

describe('server gateway over real sockets', () => {
  let harness: Harness;

  before(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-gw-'));
    const db = TycoonDb.open(path.join(dir, 'test.db'));
    // Bare http server: register a fallback request handler BEFORE socket.io
    // attaches (attach captures the listeners present at that moment and
    // defers non-socket requests to them) — otherwise plain HTTP requests
    // hang forever with no response.
    const httpServer = createServer((_req, res) => {
      res.statusCode = 404;
      res.end('not found');
    });
    const io = new SocketIoServer(httpServer);
    setupGateway(io, db);
    const clients: ClientSocket[] = [];

    harness = await new Promise<Harness>((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => {
        const address = httpServer.address();
        const port = typeof address === 'object' && address !== null ? address.port : 0;
        resolve({
          port,
          db,
          makeGame(gameId) {
            const created = GameHost.create(db, io, { mode: 'CLASSIC', playerIds: ['p1', 'p2'], gameId, seed: SEED });
            const snapshot = db.loadSnapshot(gameId);
            assert.ok(snapshot);
            return { gameId: created.gameId, roomCode: created.roomCode, version: snapshot.state.version };
          },
          makeSession(gameId, actorId) {
            return db.createSession({ gameId, actorId, name: `Player ${actorId}` }).token;
          },
          connect(auth = {}) {
            const client = createClient(`http://127.0.0.1:${port}`, { auth, transports: ['websocket'], forceNew: true });
            clients.push(client);
            return new Promise((resolve, reject) => {
              const timer = setTimeout(() => reject(new Error('connect timeout')), 5_000);
              client.on('connect', () => {
                clearTimeout(timer);
                resolve(client);
              });
              client.on('connect_error', (error: Error) => {
                clearTimeout(timer);
                reject(error);
              });
            });
          },
          async close() {
            for (const client of clients) client.disconnect();
            await new Promise<void>((resolve) => {
              io.close(() => {
                httpServer.close(() => resolve());
              });
              httpServer.closeAllConnections?.();
            });
            db.close();
          },
        });
      });
    });
  });

  after(async () => {
    await harness.close();
  });

  it('boots the gateway and answers plain HTTP on the same port', async () => {
    // The bare harness 404s app routes (no Next here); the full-server boot
    // smoke proves /, /game, /demo return 200 through the same wiring.
    const response = await fetch(`http://127.0.0.1:${harness.port}/`);
    assert.equal(response.status, 404);
  });

  it('rejects an unauthenticated game:command before the queue — no state change, no disconnect', async () => {
    const client = await harness.connect();
    const errorPromise = nextEvent<{ code: string }>(client, 'game:error');
    const ack = await ackOf(client, { type: 'START_GAME', gameId: 'g-x', actorId: 'p1', commandId: 'c-1', expectedVersion: 1 });
    assert.equal(ack.ok, false);
    if (!ack.ok) assert.equal(ack.error.code, 'UNAUTHENTICATED');
    const emitted = await errorPromise;
    assert.equal(emitted.code, 'UNAUTHENTICATED');
    assert.equal(client.connected, true, 'a rejected command must never disconnect the socket');
  });

  it('rejects a handshake with a bad token (connect_error INVALID_SESSION)', async () => {
    await assert.rejects(
      () => harness.connect({ token: 'deadbeef' }),
      (error: Error) => /INVALID_SESSION/.test(error.message),
    );
  });

  it('applies a session-stamped command, broadcasts to the room, and redacts state (criterion 11)', async () => {
    const { gameId, version } = harness.makeGame('g-gw-redact');
    const aliceToken = harness.makeSession(gameId, 'p1');
    const bobToken = harness.makeSession(gameId, 'p2');

    const bob = await harness.connect({ token: bobToken });
    const statePromise = nextEvent<Record<string, unknown>>(bob, 'game:state');
    const eventPromise = nextEvent<AnyGameEvent>(bob, 'game:event');

    const alice = await harness.connect({ token: aliceToken });
    const ack = await ackOf(alice, {
      type: 'START_GAME',
      gameId,
      actorId: 'p1',
      commandId: 'c-start-1',
      expectedVersion: version,
      payload: {},
    });

    assert.equal(ack.ok, true);
    if (ack.ok) {
      assert.equal(ack.applied, true);
      assert.equal(ack.events[0]?.type, 'TURN_STARTED');
    }

    // The room receives the stamped event and redacted state.
    const event = await eventPromise;
    assert.equal(event.type, 'TURN_STARTED');
    const state = await statePromise;
    assert.equal(state.phase, 'PLAYING');

    // Redaction scan (criterion 11): no private key anywhere in the payload.
    assert.equal(hasKeyDeep(state, 'seed'), false, 'seed leaked in game:state');
    assert.equal(hasKeyDeep(state, 'rngState'), false, 'rngState leaked in game:state');
    assert.equal(hasKeyDeep(state, 'eventDeck'), false, 'eventDeck leaked in game:state');

    // The applied command is in the durable ledger.
    assert.ok(harness.db.getStoredEvents(gameId, 'c-start-1'));
  });

  it('stamps identity from the session and ignores client claims (criterion 4)', async () => {
    const { gameId, version } = harness.makeGame('g-gw-ident');
    const p1Token = harness.makeSession(gameId, 'p1');
    const p2Token = harness.makeSession(gameId, 'p2');

    const alice = await harness.connect({ token: p1Token });
    const bob = await harness.connect({ token: p2Token });

    const startAck = await ackOf(alice, {
      type: 'START_GAME',
      gameId,
      actorId: 'p1',
      commandId: 'c-start-2',
      expectedVersion: version,
      payload: {},
    } satisfies GameCommand);
    assert.equal(startAck.ok, true);

    // If the client claim were honored, bob (claiming the active player p1)
    // would pass authorization. The session stamp wins (p2) → NOT_AUTHORIZED.
    const forgedAck = await ackOf(bob, {
      type: 'ROLL',
      gameId,
      actorId: 'p1', // forged claim
      commandId: 'c-forge-1',
      expectedVersion: version + 1,
      payload: {},
    } satisfies GameCommand);
    assert.equal(forgedAck.ok, false);
    if (!forgedAck.ok) assert.equal(forgedAck.error.code, 'NOT_AUTHORIZED');

    // The genuine actor passes authorization even while lying about its own
    // actorId, because the claim is dropped and the stamp (p1, active) applies.
    const genuineAck = await ackOf(alice, {
      type: 'ROLL',
      gameId,
      actorId: 'p2', // wrong claim, ignored
      commandId: 'c-roll-1',
      expectedVersion: version + 1,
      payload: {},
    } satisfies GameCommand);
    assert.equal(genuineAck.ok, true);
    if (genuineAck.ok) assert.equal(genuineAck.applied, true);

    // A forged gameId is replaced by the session binding: the command runs
    // against the session's game (now at version + 1 with a fresh commandId)
    // → VERSION_CONFLICT. Had the claimed gameId been honored, the pipeline
    // would have answered GAME_NOT_FOUND for the unknown game instead.
    const wrongGameAck = await ackOf(alice, {
      type: 'START_GAME',
      gameId: 'g-somewhere-else',
      actorId: 'p1',
      commandId: 'c-wrong-game',
      expectedVersion: 1,
      payload: {},
    } satisfies GameCommand);
    assert.equal(wrongGameAck.ok, false);
    if (!wrongGameAck.ok) assert.equal(wrongGameAck.error.code, 'VERSION_CONFLICT');
  });

  it('returns stored events on an idempotent retry (applied: false)', async () => {
    const { gameId, version } = harness.makeGame('g-gw-idem');
    const token = harness.makeSession(gameId, 'p1');
    const alice = await harness.connect({ token });

    const command: GameCommand = {
      type: 'START_GAME',
      gameId,
      actorId: 'p1',
      commandId: 'c-same-1',
      expectedVersion: version,
      payload: {},
    };
    const first = await ackOf(alice, command);
    const second = await ackOf(alice, command);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (first.ok && second.ok) {
      assert.equal(first.applied, true);
      assert.equal(second.applied, false);
      assert.deepEqual(second.events, first.events);
    }
  });

  it('admits exactly 20 commands per 10s then returns RATE_LIMITED without disconnecting (criterion 8)', async () => {
    const { gameId, version } = harness.makeGame('g-gw-rate');
    const token = harness.makeSession(gameId, 'p1');
    const alice = await harness.connect({ token });

    const bogus = { type: 'NOT_A_COMMAND', gameId, actorId: 'p1', commandId: 'c-bogus', expectedVersion: version };
    const acks: WireCommandResult[] = [];
    for (let i = 0; i < 30; i++) acks.push(await ackOf(alice, bogus));

    const limited = acks.filter((a) => !a.ok && a.error.code === 'RATE_LIMITED');
    const passed = acks.filter((a) => !(a.ok === false && a.error.code === 'RATE_LIMITED'));
    assert.equal(passed.length, 20, 'exactly the 20-command budget passes the limiter');
    assert.equal(limited.length, 10, 'the burst remainder is rate-limited');
    assert.equal(alice.connected, true, 'the limiter never disconnects');

    // State integrity: none of the burst applied, so the version is untouched.
    const snapshot = harness.db.loadSnapshot(gameId);
    assert.ok(snapshot);
    assert.equal(snapshot.state.version, version);
  });
});
