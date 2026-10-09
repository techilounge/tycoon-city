/** Deterministic RNG contract tests (spec §3). */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mulberry32, rngForState } from '../../src/lib/game/rng';

test('rng: identical seeds produce identical sequences across fresh instances', () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  const seqA = Array.from({ length: 100 }, () => a.next());
  const seqB = Array.from({ length: 100 }, () => b.next());
  assert.deepEqual(seqA, seqB);
});

test('rng: different seeds diverge', () => {
  const a = mulberry32(1);
  const b = mulberry32(2);
  const seqA = Array.from({ length: 32 }, () => a.next());
  const seqB = Array.from({ length: 32 }, () => b.next());
  assert.notDeepEqual(seqA, seqB);
});

test('rng: output is within [0, 1) over 10k draws', () => {
  const rng = mulberry32(0xc0ffee);
  for (let i = 0; i < 10_000; i++) {
    const value = rng.next();
    assert.ok(value >= 0 && value < 1, `draw ${i} out of range: ${value}`);
  }
});

test('rng: getState advances with draws and is uint32', () => {
  const rng = mulberry32(7);
  const first = rng.getState();
  assert.ok(Number.isInteger(first) && first >= 0 && first <= 0xffffffff);
  rng.next();
  const second = rng.getState();
  rng.next();
  const third = rng.getState();
  assert.notEqual(first, second);
  assert.notEqual(second, third);
});

test('rng: continuation via rngForState matches the uninterrupted sequence', () => {
  const rng = mulberry32(1234);
  for (let i = 0; i < 50; i++) rng.next();
  const word = rng.getState();
  const resumed = rngForState(word);
  const restA = Array.from({ length: 100 }, () => rng.next());
  const restB = Array.from({ length: 100 }, () => resumed.next());
  assert.deepEqual(restA, restB);
});

test('rng: resume-from-saved-word equals the same uninterrupted run (save/resume contract)', () => {
  const live = mulberry32(0xabcdef01);
  for (let i = 0; i < 20; i++) live.next();
  const savedWord = live.getState();
  const expected = [live.next(), live.next(), live.next()];
  const restored = rngForState(savedWord);
  assert.deepEqual([restored.next(), restored.next(), restored.next()], expected);
});

test('rng: nextInt is uniform-bounded and rejects invalid maxima', () => {
  const rng = mulberry32(99);
  for (let i = 0; i < 1000; i++) {
    const value = rng.nextInt(6);
    assert.ok(Number.isInteger(value) && value >= 0 && value < 6);
  }
  assert.throws(() => rng.nextInt(0), RangeError);
  assert.throws(() => rng.nextInt(-3), RangeError);
  assert.throws(() => rng.nextInt(1.5), RangeError);
});

test('rng: shuffle is a permutation and deterministic for a given state', () => {
  const source = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const a = mulberry32(555);
  const b = mulberry32(555);
  const shuffledA = a.shuffle(source);
  const shuffledB = b.shuffle(source);
  assert.deepEqual(shuffledA, shuffledB);
  assert.deepEqual([...shuffledA].sort(), source, 'shuffle preserves membership');
  assert.deepEqual(source, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], 'input is not mutated');
  const counts = new Map<string, number>();
  for (let run = 0; run < 200; run++) {
    const shuffled = mulberry32(run).shuffle(source);
    counts.set(shuffled[0], (counts.get(shuffled[0]) ?? 0) + 1);
  }
  assert.ok(counts.size > 1, 'first element should vary across seeds');
});

test('rng: seed lifecycle — seed words live in state, never in event meta (state-hash equality)', () => {
  // Continuation from state.rngState must equal uninterrupted play; this is
  // the property the reducer relies on when persisting the word.
  const seed = 0xfeedface;
  const direct = mulberry32(seed);
  direct.next();
  const saved = direct.getState();
  const expected = [direct.next(), direct.next()];
  const resumed = rngForState(saved);
  assert.deepEqual([resumed.next(), resumed.next()], expected);
});

test('rng: seed is masked to uint32; word 0 is a valid state', () => {
  assert.equal(mulberry32(-1).getState(), 0xffffffff, 'seed is masked with >>> 0');
  assert.equal(mulberry32(0).getState(), 0, 'zero is a valid starting word');
  assert.equal(rngForState(42).getState(), 42, 'rngForState resumes from the persisted word');
});
