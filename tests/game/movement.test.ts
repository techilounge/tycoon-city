import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BOARD_LOOP_SIZE, BOARD_SPACES } from '../../src/lib/game/board-v1';
import { moveForward, nearestParkIndex } from '../../src/lib/game/engine/movement';

const PARK_INDEXES = BOARD_SPACES.map((s, i) => (s.kind === 'PARK' ? i : -1)).filter((i) => i >= 0);

describe('moveForward', () => {
  it('moves forward around the loop without crossing the start', () => {
    const move = moveForward(0, 7, BOARD_LOOP_SIZE);
    assert.equal(move.toIndex, 7);
    assert.equal(move.direction, 'FORWARD');
    assert.equal(move.passesGateway, false);
  });

  it('marks passesGateway when the move crosses Gateway Terminal', () => {
    const move = moveForward(28, 7, BOARD_LOOP_SIZE); // 28 + 7 = 35 → 3, crossed 0
    assert.equal(move.toIndex, 3);
    assert.equal(move.passesGateway, true);
  });

  it('marks passesGateway when the move lands exactly on Gateway Terminal', () => {
    const move = moveForward(26, 6, BOARD_LOOP_SIZE); // 26 + 6 = 32 → 0
    assert.equal(move.toIndex, 0);
    assert.equal(move.passesGateway, true);
  });

  it('a mid-board move never grants the bonus', () => {
    for (let from = 1; from < BOARD_LOOP_SIZE - 12; from++) {
      const move = moveForward(from, 12, BOARD_LOOP_SIZE);
      assert.equal(move.passesGateway, false, `from ${from} + 12 must not cross 0`);
    }
  });

  it('wraps the full 32-space loop (spec §8: closed loop)', () => {
    assert.equal(BOARD_SPACES.length, 32);
    for (let from = 0; from < 32; from++) {
      for (const spaces of [2, 7, 12]) {
        const move = moveForward(from, spaces, BOARD_LOOP_SIZE);
        assert.equal(move.toIndex, (from + spaces) % 32);
      }
    }
  });

  it('rejects out-of-range and non-positive inputs', () => {
    assert.throws(() => moveForward(-1, 3, BOARD_LOOP_SIZE), RangeError);
    assert.throws(() => moveForward(32, 3, BOARD_LOOP_SIZE), RangeError);
    assert.throws(() => moveForward(0, 0, BOARD_LOOP_SIZE), RangeError);
    assert.throws(() => moveForward(0, 2.5, BOARD_LOOP_SIZE), RangeError);
  });
});

describe('nearestParkIndex', () => {
  it('the board has three parks (spec §8 board layout)', () => {
    assert.deepEqual(PARK_INDEXES, [8, 23, 30]);
  });

  it('walks forward to the nearest park', () => {
    assert.equal(nearestParkIndex(1, BOARD_SPACES), 8);
    assert.equal(nearestParkIndex(9, BOARD_SPACES), 23);
    assert.equal(nearestParkIndex(24, BOARD_SPACES), 30);
  });

  it('wraps around the loop when no park lies ahead', () => {
    assert.equal(nearestParkIndex(31, BOARD_SPACES), 8);
  });

  it('a token already on a park wraps a full loop to the next one', () => {
    assert.equal(nearestParkIndex(8, BOARD_SPACES), 23);
    assert.equal(nearestParkIndex(30, BOARD_SPACES), 8);
  });

  it('rejects out-of-range positions', () => {
    assert.throws(() => nearestParkIndex(-1, BOARD_SPACES), RangeError);
    assert.throws(() => nearestParkIndex(32, BOARD_SPACES), RangeError);
  });
});
