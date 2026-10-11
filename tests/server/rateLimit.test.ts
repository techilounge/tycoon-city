import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { COMMAND_LIMIT, JOIN_LIMIT, SlidingWindowRateLimiter } from '../../server/rateLimit';

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
