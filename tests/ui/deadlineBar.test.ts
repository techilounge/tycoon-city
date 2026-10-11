/**
 * DeadlineBar logic tests (presentation-only component; the server enforces
 * deadlines — spec "Client experience"). The share math must be a pure
 * function of the broadcast alone.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { remainingShare } from '../../src/components/DeadlineBar';

describe('DeadlineBar remainingShare', () => {
  const durationMs = 90_000;

  it('is 1 at the moment the deadline is set', () => {
    const now = 1_000_000;
    assert.equal(remainingShare({ label: 'Your turn', endsAtMs: now + durationMs, durationMs, nowMs: now }), 1);
  });

  it('decays proportionally with elapsed time', () => {
    const now = 1_000_000;
    const endsAtMs = now + durationMs;
    const half = remainingShare({ label: 'Your turn', endsAtMs, durationMs, nowMs: now + durationMs / 2 });
    assert.ok(Math.abs(half - 0.5) < 0.001, `half-life should be ~0.5, got ${half}`);
  });

  it('clamps to 0 once expired', () => {
    const now = 1_000_000;
    assert.equal(remainingShare({ label: 'Your turn', endsAtMs: now - 1, durationMs, nowMs: now }), 0);
    assert.equal(remainingShare({ label: 'Your turn', endsAtMs: now - 60_000, durationMs, nowMs: now }), 0);
  });

  it('clamps to 1 for clock skew (never inflates)', () => {
    const now = 1_000_000;
    const share = remainingShare({ label: 'Your turn', endsAtMs: now + durationMs + 60_000, durationMs, nowMs: now });
    assert.equal(share, 1);
  });

  it('is 0 for a zero-duration deadline', () => {
    const now = 1_000_000;
    assert.equal(remainingShare({ label: 'Your turn', endsAtMs: now, durationMs: 0, nowMs: now }), 0);
  });
});
