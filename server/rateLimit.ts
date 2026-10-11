/**
 * Sliding-window rate limits (spec criterion 8): 20 commands per rolling 10 s
 * per connection and 5 room joins per minute per IP. The limiter sits before
 * the per-game queue: exceeding it returns `game:error {code: 'RATE_LIMITED'}`
 * — never a disconnect, and never a state change. The clock is injectable so
 * unit tests run without fake timers.
 */
export interface RateLimitConfig {
  /** Maximum hits inside any windowMs. */
  readonly max: number;
  readonly windowMs: number;
}

/** Per-connection command budget, checked before the queue. */
export const COMMAND_LIMIT: RateLimitConfig = { max: 20, windowMs: 10_000 };

/**
 * Per-IP room-join budget. PR 14 ships the policy and the primitive; the
 * `game:join` socket event that consumes it arrives with the room-lifecycle
 * layer (Phase 2 PR 15).
 */
export const JOIN_LIMIT: RateLimitConfig = { max: 5, windowMs: 60_000 };

export class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly config: RateLimitConfig,
    private readonly now: () => number = Date.now,
  ) {}

  /** Consume one slot for `key`; false when the window budget is spent. */
  tryTake(key: string): boolean {
    const nowMs = this.now();
    const windowStart = nowMs - this.config.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > windowStart);
    if (recent.length >= this.config.max) {
      this.hits.set(key, recent); // keep pruned
      return false;
    }
    recent.push(nowMs);
    this.hits.set(key, recent);
    return true;
  }

  reset(): void {
    this.hits.clear();
  }
}
