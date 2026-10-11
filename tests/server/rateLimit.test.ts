import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import type { GameCommand } from '../../src/lib/game/commands';
import { stateHash } from '../../src/lib/game/engine/replay';
import { SOCKET_EVENTS, type SessionAck, type WireCommandResult } from '../../src/lib/game/transport/protocol';
import { COMMAND_LIMIT, JOIN_LIMIT, SlidingWindowRateLimiter } from '../../server/rateLimit';
import { startHarness, type TestHarness } from './helpers';
import { WireClient } from './wireDriver';

const CREATE = SOCKET_EVENTS.create;
const JOIN = SOCKET_EVENTS.join;

describe('SlidingWindowRateLimiter', () => {
  it('admits exactly max hits inside the window, then refuses', () => {
    let now = 1_000;
    const limiter = new SlidingWindowRateLimiter({ max: 3, windowMs: 1_000 }, () => now);
    assert.equal(limiter.tryTake('conn-1'), true);
    assert.equal(limiter.tryTake('conn-1'), true);
    assert.equal(limiter.tryTake('conn-1'), true);
    assert.equal(limiter.tryTake('conn-1'), false);
    assert.equal(limiter.tryTake('conn-1'), false);
  });

  it('isolates keys — one connection budget never spends another', () => {
    let now = 1_000;
    const limiter = new SlidingWindowRateLimiter({ max: 1, windowMs: 1_000 }, () => now);
    assert.equal(limiter.tryTake('conn-1'), true);
    assert.equal(limiter.tryTake('conn-1'), false);
    assert.equal(limiter.tryTake('conn-2'), true);
  });

  it('frees slots as the window slides', () => {
    let now = 1_000;
    const limiter = new SlidingWindowRateLimiter({ max: 2, windowMs: 1_000 }, () => now);
    assert.equal(limiter.tryTake('conn-1'), true);
    assert.equal(limiter.tryTake('conn-1'), true);
    assert.equal(limiter.tryTake('conn-1'), false);
    now = 1_400; // both hits still inside the 1s window
    assert.equal(limiter.tryTake('conn-1'), false);
    now = 2_000.1; // both hits have slid out
    assert.equal(limiter.tryTake('conn-1'), true);
  });

  it('is a rolling window, not a fixed bucket', () => {
    let now = 1_000;
    const limiter = new SlidingWindowRateLimiter({ max: 2, windowMs: 1_000 }, () => now);
    assert.equal(limiter.tryTake('c'), true);
    now = 1_600;
    assert.equal(limiter.tryTake('c'), true);
    now = 2_100; // first hit expired, second still inside
    assert.equal(limiter.tryTake('c'), true);
    assert.equal(limiter.tryTake('c'), false); // 2 hits inside 1s again
  });

  it('ships the spec policies (criterion 8)', () => {
    assert.deepEqual(COMMAND_LIMIT, { max: 20, windowMs: 10_000 });
    assert.deepEqual(JOIN_LIMIT, { max: 5, windowMs: 60_000 });
  });
});

describe('rate limits over the wire (criterion 8, end to end)', () => {
  it('a 30-command burst: 20 processed, 10 RATE_LIMITED, state hash unaffected', async () => {
    const harness: TestHarness = await startHarness();
    try {
      const creator = await WireClient.connect(harness);
      const created = (await harness.ack(creator.socket, CREATE, { mode: 'BLITZ', seatCount: 2, name: 'A' })) as SessionAck;
      await creator.waitForVersion(0);
      const snapshot = harness.db.loadSnapshot(created.gameId);
      assert.ok(snapshot);
      const hashBefore = stateHash(snapshot.state);

      // All 30 are shape-valid but rule-rejected in LOBBY phase — every
      // limiter pass is "processed", none changes state.
      const burst = (await Promise.all(
        Array.from({ length: 30 }, (_, i) =>
          creator.command({
            commandId: `burst-${i}`, gameId: created.gameId, actorId: 'p1',
            expectedVersion: creator.state.version, type: 'ROLL', payload: {},
          } as GameCommand),
        ),
      )) as WireCommandResult[];
      const limited = burst.filter((r) => !r.ok && r.error.code === 'RATE_LIMITED');
      assert.equal(burst.length - limited.length, 20, 'limiter must pass exactly the first 20');
      assert.equal(limited.length, 10, 'the remaining 10 must be RATE_LIMITED');

      const after = harness.db.loadSnapshot(created.gameId);
      assert.ok(after);
      assert.equal(stateHash(after.state), hashBefore, 'burst must not touch state');
    } finally {
      harness.close();
    }
  });

  it('fresh joins are capped at 5 room operations per minute per IP', async () => {
    const harness: TestHarness = await startHarness();
    try {
      const creator = await WireClient.connect(harness);
      const created = (await harness.ack(creator.socket, CREATE, { mode: 'BLITZ', seatCount: 2, name: 'A' })) as SessionAck;

      const outcomes: string[] = [];
      for (let i = 0; i < 5; i++) {
        const client = await WireClient.connect(harness);
        const ack = (await harness.ack(client.socket, JOIN, { code: created.roomCode, name: `J${i}` })) as
          | SessionAck
          | { ok: false; error: { code: string } };
        outcomes.push(ack.ok ? 'ok' : ack.error.code);
      }
      // Create consumed 1 of 5; the first fresh join claims seat two; the
      // next three are ROOM_FULL but still consume budget; the 5th is refused.
      assert.equal(outcomes[0], 'ok');
      assert.deepEqual(outcomes.slice(1, 4), ['ROOM_FULL', 'ROOM_FULL', 'ROOM_FULL']);
      assert.equal(outcomes[4], 'RATE_LIMITED');
    } finally {
      harness.close();
    }
  });
});
