import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { perimeterGridPosition, CENTER_PLACEMENT } from '../../src/lib/game/ui/boardLayout';

/** The perimeter layout math (spec §12 PR 10): 32 cells around a 9×9 ring. */

const positions = Array.from({ length: 32 }, (_, index) => ({ index, ...perimeterGridPosition(index) }));

describe('perimeterGridPosition', () => {
  it('places the four corners on indices 0, 8, 16, 24', () => {
    assert.deepEqual(perimeterGridPosition(0), { row: 9, col: 9 });
    assert.deepEqual(perimeterGridPosition(8), { row: 9, col: 1 });
    assert.deepEqual(perimeterGridPosition(16), { row: 1, col: 1 });
    assert.deepEqual(perimeterGridPosition(24), { row: 1, col: 9 });
  });

  it('maps all 32 indices to distinct cells inside the 9×9 grid', () => {
    for (const { index, row, col } of positions) {
      assert.ok(row >= 1 && row <= 9 && col >= 1 && col <= 9, `index ${index} lands inside the grid`);
    }
    const keys = new Set(positions.map(({ row, col }) => `${row}:${col}`));
    assert.equal(keys.size, 32, 'every ring cell is distinct');
  });

  it('keeps consecutive indices orthogonally adjacent, wrapping 31 → 0', () => {
    for (let i = 0; i < 32; i++) {
      const a = perimeterGridPosition(i);
      const b = perimeterGridPosition((i + 1) % 32);
      const distance = Math.abs(a.row - b.row) + Math.abs(a.col - b.col);
      assert.equal(distance, 1, `index ${i} and ${((i + 1) % 32)} are neighbors`);
    }
  });

  it('refuses out-of-range indices', () => {
    assert.throws(() => perimeterGridPosition(-1));
    assert.throws(() => perimeterGridPosition(32));
    assert.throws(() => perimeterGridPosition(1.5));
  });

  it('reserves rows and columns 2–8 for the center panel', () => {
    assert.deepEqual(CENTER_PLACEMENT, { gridRow: '2 / span 7', gridColumn: '2 / span 7' });
    for (const { row, col } of positions) {
      const inCenter = row >= 2 && row <= 8 && col >= 2 && col <= 8;
      assert.ok(!inCenter, `ring cell (${row},${col}) never overlaps the center panel`);
    }
  });
});
