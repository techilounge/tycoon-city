/**
 * Pure movement mechanics for the turn machine (spec §4 rows 3–4).
 *
 * Deterministic, board-data-driven functions; the reducer composes their
 * outcomes into events. No state, no clock, no randomness — callers supply
 * positions and the board, and identical inputs always yield identical
 * outcomes.
 */
import type { BoardSpace } from '../board-v1';
import type { MoveDirection } from '../events';

/** Where a token ends up after a move, and what the move crossed. */
export interface MoveOutcome {
  readonly toIndex: number;
  readonly direction: MoveDirection;
  /** True when a FORWARD move passed or landed on Gateway Terminal (index 0) —
   *  the start bonus fires (spec §4 row 3). Backward movement never grants it. */
  readonly passesGateway: boolean;
}

/**
 * Forward walk around the closed loop (spec §4 row 3). A move "passes"
 * Gateway Terminal exactly when it crosses or lands on index 0, i.e. when
 * fromIndex + spaces reaches the loop size.
 */
export function moveForward(fromIndex: number, spaces: number, loopSize: number): MoveOutcome {
  if (!Number.isInteger(fromIndex) || fromIndex < 0 || fromIndex >= loopSize) {
    throw new RangeError(`moveForward: fromIndex out of board range, got ${fromIndex}`);
  }
  if (!Number.isInteger(spaces) || spaces <= 0) {
    throw new RangeError(`moveForward: spaces must be a positive integer, got ${spaces}`);
  }
  return {
    toIndex: (fromIndex + spaces) % loopSize,
    direction: 'FORWARD',
    passesGateway: fromIndex + spaces >= loopSize,
  };
}

/**
 * Board index of the nearest park walking FORWARD around the loop (spec §4
 * row 4: the third-doubles penalty moves the token to the nearest Park).
 * Forward is the penalty idiom of the genre — the token advances to the
 * park ahead of it — and keeps the outcome deterministic. A token already ON
 * a park wraps a full loop to the next one, matching the nearest-hub
 * convention in rules-v1's resolveCardMove.
 */
export function nearestParkIndex(fromIndex: number, spaces: readonly BoardSpace[]): number {
  if (!Number.isInteger(fromIndex) || fromIndex < 0 || fromIndex >= spaces.length) {
    throw new RangeError(`nearestParkIndex: fromIndex out of board range, got ${fromIndex}`);
  }
  const parkIndexes = spaces
    .map((space, index) => (space.kind === 'PARK' ? index : -1))
    .filter((index) => index >= 0);
  if (parkIndexes.length === 0) {
    throw new Error('board data: nearestParkIndex needs a park on the board');
  }
  let bestIndex = parkIndexes[0];
  // A zero distance (already there) counts as a full loop.
  let bestDistance = (bestIndex - fromIndex + spaces.length) % spaces.length || spaces.length;
  for (const parkIndex of parkIndexes.slice(1)) {
    const distance = (parkIndex - fromIndex + spaces.length) % spaces.length || spaces.length;
    if (distance < bestDistance) {
      bestIndex = parkIndex;
      bestDistance = distance;
    }
  }
  return bestIndex;
}
