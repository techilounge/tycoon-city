/**
 * Deterministic randomness (spec §3): Mulberry32, a fast 32-bit PRNG.
 *
 * Explicit disclosure (spec §3): Mulberry32 is fully deterministic but is
 * NOT a cryptographically secure generator — it must never guard secrets.
 * Phase 1 hot-seat play keeps all state on one trusted device; Phase 2 keeps
 * seeds and PRNG state server-private. The RandomSource interface is the seam
 * where a Phase 2 server swaps in a different generator without touching the
 * engine contract.
 *
 * The engine's entire randomness state is one 32-bit word. Every draw
 * advances it, and the reducer persists the current word into
 * state.rngState after each command — so RNG position survives save/resume
 * with zero extra bookkeeping.
 */

export interface RandomSource {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [0, max). Throws on max < 1 — a caller bug, not a rule outcome. */
  nextInt(max: number): number;
  /** Deterministic Fisher–Yates shuffle; returns a new array, input untouched. */
  shuffle<T>(items: readonly T[]): T[];
  /** Current 32-bit word; the reducer persists this into state.rngState after a command's draws. */
  getState(): number;
}

/**
 * Canonical Mulberry32 construction (public-domain reference implementation).
 * The accumulator is re-masked each step, which keeps the state word in
 * 32-bit range and makes resume-from-getState exact.
 */
export function mulberry32(seed: number): RandomSource {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const nextInt = (max: number): number => {
    if (!Number.isSafeInteger(max) || max < 1) {
      throw new RangeError(`nextInt(max) requires a positive safe integer, got ${String(max)}`);
    }
    return Math.floor(next() * max);
  };
  const shuffle = <T>(items: readonly T[]): T[] => {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = nextInt(i + 1);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };
  return {
    next,
    nextInt,
    shuffle,
    getState: (): number => a >>> 0,
  };
}

/**
 * The canonical source for folding: seeded from the persisted word, so live
 * play, replay, and post-snapshot continuation all draw identically. The
 * reducer and the transport layer use this; nothing else should.
 */
export function rngForState(rngState: number): RandomSource {
  return mulberry32(rngState);
}
