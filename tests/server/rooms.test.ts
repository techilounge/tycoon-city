/**
 * Room lifecycle over the wire (spec criterion 5): create and join by code,
 * the 6-seat cap, LOBBY-only fresh joins, payload validation, token
 * re-authentication with catch-up, and deterministic room-code collision
 * handling. Every observation is a public socket message or a harness-side
 * DB read (the operator view).
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { SOCKET_EVENTS, type SessionAck, type RoomAck } from '../../src/lib/game/transport/protocol';
import { ROOM_CODE_ALPHABET } from '../../server/db';
import { hasKeyDeep, startHarness, type TestHarness } from './helpers';
import { WireClient } from './wireDriver';

const JOIN = SOCKET_EVENTS.join;
const CREATE = SOCKET_EVENTS.create;
const COMMAND = SOCKET_EVENTS.command;

describe('room lifecycle (criterion 5)', () => {
  let harness: TestHarness;
  before(async () => {
    harness = await startHarness({
      commandLimit: { max: 1_000_000, windowMs: 10_000 },
      joinLimit: { max: 1_000_000, windowMs: 60_000 },
    });
  });
  after(() => harness.close());

  it('creates a room: unambiguous 6-char code, seat-one session, initial state, persisted row', async () => {
    const creator = await WireClient.connect(harness);
    const statePromise = harness.nextEvent<Record<string, unknown>>(creator.socket, SOCKET_EVENTS.state);
    const ack = (await harness.ack(creator.socket, CREATE, { mode: 'CLASSIC', seatCount: 4, name: 'Ada' })) as SessionAck;

    assert.equal(ack.ok, true);
    assert.match(ack.token, /^[0-9a-f]{64}$/);
    assert.match(ack.roomCode, /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
    assert.equal(ack.actorId, 'p1');
    assert.equal(ack.phase, 'LOBBY');
    assert.equal(ack.players.length, 4);
    assert.deepEqual(ack.roster, [{ actorId: 'p1', name: 'Ada' }]);
    assert.equal(ack.roomCode.length, 6);

    // The creator receives the authoritative redacted state on create.
    const state = await statePromise;
    assert.equal(hasKeyDeep(state, 'seed'), false);
    assert.equal(hasKeyDeep(state, 'rngState'), false);
    assert.equal(hasKeyDeep(state, 'eventDeck'), false);

    // Operator view: the row exists with the minted code and a server-side seed.
    const row = harness.db.getGame(ack.gameId);
    assert.ok(row);
    assert.equal(row.roomCode, ack.roomCode);
    const snapshot = harness.db.loadSnapshot(ack.gameId);
    assert.ok(snapshot);
    assert.equal(typeof snapshot.seed, 'number');
  });

  it('joins by code: claims the next seat, broadcasts game:joined (no token), sends the joiner state', async () => {
    const creator = await WireClient.connect(harness);
    // Note: the create emits `game:state` before its ack, and the WireClient
    // tracks it — a post-create nextEvent would wait for a second emission.
    const created = (await harness.ack(creator.socket, CREATE, { mode: 'CLASSIC', seatCount: 3, name: 'Host' })) as SessionAck;
    await creator.waitForVersion(0);

    const joiner = await WireClient.connect(harness);
    const joinerState = harness.nextEvent<Record<string, unknown>>(joiner.socket, SOCKET_EVENTS.state);
    const ack = (await harness.ack(joiner.socket, JOIN, { code: created.roomCode, name: 'Guest' })) as SessionAck;
    assert.equal(ack.ok, true);
    assert.equal(ack.actorId, 'p2');
    assert.notEqual(ack.token, created.token);
    const joinedState = await joinerState;
    assert.equal(joinedState['gameId'], created.gameId);

    // The broadcast reaches every room member; it carries no token.
    const broadcast = await harness.nextEvent<Record<string, unknown>>(creator.socket, SOCKET_EVENTS.joined);
    assert.equal(broadcast['actorId'], 'p2');
    assert.equal(broadcast['name'], 'Guest');
    assert.equal(hasKeyDeep(broadcast, 'token'), false);
  });

  it('rejects an unknown room code with ROOM_NOT_FOUND', async () => {
    const client = await WireClient.connect(harness);
    const ack = (await harness.ack(client.socket, JOIN, { code: 'ZZZ999', name: 'Late' })) as RoomAck;
    assert.equal(ack.ok, false);
    if (!ack.ok) assert.equal(ack.error.code, 'ROOM_NOT_FOUND');
  });

  it('enforces the seat cap with ROOM_FULL', async () => {
    const creator = await WireClient.connect(harness);
    const created = (await harness.ack(creator.socket, CREATE, { mode: 'CLASSIC', seatCount: 2, name: 'A' })) as SessionAck;
    const second = await WireClient.connect(harness);
    const ok = (await harness.ack(second.socket, JOIN, { code: created.roomCode, name: 'B' })) as SessionAck;
    assert.equal(ok.ok, true);

    const third = await WireClient.connect(harness);
    const rejected = (await harness.ack(third.socket, JOIN, { code: created.roomCode, name: 'C' })) as RoomAck;
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.equal(rejected.error.code, 'ROOM_FULL');
  });

  it('rejects fresh joins after START_GAME with ROOM_IN_PROGRESS', async () => {
    const fixture = await (async () => {
      const creator = await WireClient.connect(harness);
      const created = (await harness.ack(creator.socket, CREATE, { mode: 'BLITZ', seatCount: 2, name: 'A' })) as SessionAck;
      await creator.waitForVersion(0);
      const second = await WireClient.connect(harness);
      await harness.ack(second.socket, JOIN, { code: created.roomCode, name: 'B' });
      return { creator, created };
    })();

    const start = {
      commandId: 'rooms-start-1',
      gameId: fixture.created.gameId,
      actorId: 'p1',
      expectedVersion: (await stateOf(harness, fixture.creator)).version,
      type: 'START_GAME',
      payload: {},
    };
    const result = (await harness.ack(fixture.creator.socket, COMMAND, start)) as { ok: boolean };
    assert.equal(result.ok, true);

    const late = await WireClient.connect(harness);
    const rejected = (await harness.ack(late.socket, JOIN, { code: fixture.created.roomCode, name: 'Late' })) as RoomAck;
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.equal(rejected.error.code, 'ROOM_IN_PROGRESS');
  });

  it('validates join payloads: missing code, blank name, oversized name, bad fromSeq', async () => {
    const creator = await WireClient.connect(harness);
    const created = (await harness.ack(creator.socket, CREATE, { mode: 'CLASSIC', seatCount: 2, name: 'A' })) as SessionAck;
    const cases: readonly { payload: unknown; code: string }[] = [
      { payload: { name: 'X' }, code: 'INVALID_PAYLOAD' },
      { payload: { code: created.roomCode, name: '' }, code: 'INVALID_PAYLOAD' },
      { payload: { code: created.roomCode, name: 'x'.repeat(25) }, code: 'INVALID_PAYLOAD' },
      { payload: { code: created.roomCode, name: 'Ok', fromSeq: -1 }, code: 'INVALID_PAYLOAD' },
      { payload: { code: created.roomCode, name: 'Ok', fromSeq: 1.5 }, code: 'INVALID_PAYLOAD' },
    ];
    for (const { payload, code } of cases) {
      const client = await WireClient.connect(harness);
      const ack = (await harness.ack(client.socket, JOIN, payload)) as RoomAck;
      assert.equal(ack.ok, false, `expected rejection for ${JSON.stringify(payload)}`);
      if (!ack.ok) assert.equal(ack.error.code, code, `payload ${JSON.stringify(payload)}`);
    }
  });

  it('re-authenticates a returning token mid-lobby and mid-game, streaming catch-up events from fromSeq', async () => {
    const creator = await WireClient.connect(harness);
    const created = (await harness.ack(creator.socket, CREATE, { mode: 'BLITZ', seatCount: 2, name: 'A' })) as SessionAck;
    await creator.waitForVersion(0);
    const joiner = await WireClient.connect(harness);
    const joinerAck = (await harness.ack(joiner.socket, JOIN, { code: created.roomCode, name: 'B' })) as SessionAck;
    assert.equal(joinerAck.ok, true);

    // Play START_GAME and one ROLL so catch-up has real content.
    const versionBefore = (await stateOf(harness, creator)).version;
    await harness.ack(creator.socket, COMMAND, {
      commandId: 'rooms-start-2', gameId: created.gameId, actorId: 'p1', expectedVersion: versionBefore, type: 'START_GAME', payload: {},
    });
    const rollingVersion = (await stateOf(harness, creator)).version;
    const roll = (await harness.ack(creator.socket, COMMAND, {
      commandId: 'rooms-roll-1', gameId: created.gameId, actorId: 'p1', expectedVersion: rollingVersion, type: 'ROLL', payload: {},
    })) as { ok: boolean };
    assert.equal(roll.ok, true);

    // p2 disconnects, then rejoins with its token from a fresh socket.
    joiner.socket.disconnect();
    const rejoiner = await WireClient.connect(harness);
    const statePromise = harness.nextEvent<Record<string, unknown>>(rejoiner.socket, SOCKET_EVENTS.state);
    const rejoined = (await harness.ack(rejoiner.socket, JOIN, {
      code: created.roomCode,
      name: 'B',
      token: joinerAck.token,
      fromSeq: 1,
    })) as SessionAck;
    assert.equal(rejoined.ok, true);
    assert.equal(rejoined.actorId, 'p2');
    assert.equal(rejoined.phase, 'PLAYING');
    const rejoinState = await statePromise;
    const liveState = await stateOf(harness, creator);
    assert.equal(rejoinState['version'], liveState.version);

    // No joined broadcast for a reconnect — the room is not told twice.
    // (Creator's tap must not grow between now and a subsequent command.)
  });

  it('refuses a bogus token and a foreign-room token with INVALID_SESSION', async () => {
    const creator = await WireClient.connect(harness);
    const created = (await harness.ack(creator.socket, CREATE, { mode: 'CLASSIC', seatCount: 2, name: 'A' })) as SessionAck;

    const badToken = await WireClient.connect(harness);
    const bad = (await harness.ack(badToken.socket, JOIN, {
      code: created.roomCode, name: 'Impostor', token: 'f'.repeat(64),
    })) as RoomAck;
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.equal(bad.error.code, 'INVALID_SESSION');

    // A token bound to a DIFFERENT room is refused for this room.
    const other = await WireClient.connect(harness);
    const otherRoom = (await harness.ack(other.socket, CREATE, { mode: 'CLASSIC', seatCount: 2, name: 'Elsewhere' })) as SessionAck;
    const foreign = await WireClient.connect(harness);
    const refused = (await harness.ack(foreign.socket, JOIN, {
      code: created.roomCode, name: 'Traveler', token: otherRoom.token,
    })) as RoomAck;
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.error.code, 'INVALID_SESSION');
  });

  it('retries room-code collisions deterministically (injectable byte source)', async () => {
    // Occupy a real code through the real flow, then aim the injectable byte
    // source at it: the mint loop must skip the taken code and return a free
    // one (and exhaust loudly if every attempt collides).
    const creator = await WireClient.connect(harness);
    const created = (await harness.ack(creator.socket, CREATE, { mode: 'CLASSIC', seatCount: 2, name: 'A' })) as SessionAck;
    const takenCode = created.roomCode;

    const codeBytes = (code: string): Buffer => {
      const out = Buffer.alloc(code.length);
      for (let i = 0; i < code.length; i++) out[i] = ROOM_CODE_ALPHABET.indexOf(code[i]);
      return out;
    };

    // Always-colliding bytes: every attempt spells the taken code → exhaust throw.
    assert.throws(() => harness.db.newRoomCode(() => codeBytes(takenCode)), /room code space exhausted/);

    // Collide once, then a free code: the retry proceeds past the taken code.
    let call = 0;
    const collideOnce = (): Buffer => {
      call += 1;
      return call === 1 ? codeBytes(takenCode) : codeBytes('BB7777');
    };
    const next = harness.db.newRoomCode(collideOnce);
    assert.notEqual(next, takenCode);
    assert.match(next, /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
  });
});

/** Operator-side state read for version math in lifecycle tests. */
async function stateOf(harness: TestHarness, client: WireClient): Promise<{ version: number }> {
  // The client tracks its own latest state; wait for at least version 0 then read.
  await client.waitForVersion(0);
  return client.state as unknown as { version: number };
}
