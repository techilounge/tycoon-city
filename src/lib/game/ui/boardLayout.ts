/**
 * Presentation layout for the perimeter board (spec §12 PR 10): pure index →
 * grid-position math over the 32-space loop. No React, no DOM.
 *
 * The 9×9 ring holds exactly 32 cells (9 + 7 + 9 + 7). Index 0 (Gateway
 * Terminal) sits at the bottom-right corner and play proceeds leftward along
 * the bottom row, up the left side, rightward along the top, and down the
 * right side — so corner cells land on indices 0, 8, 16, and 24.
 */

/** The board grid is 9×9: a 32-cell perimeter around a 7×7 center. */
export const BOARD_GRID_SIZE = 9;

export interface GridPosition {
  /** 1-based grid row (CSS grid, so 1 is the top). */
  readonly row: number;
  /** 1-based grid column (CSS grid, so 1 is the left). */
  readonly col: number;
}

/**
 * The 1-based CSS grid position of board index `index` (0–31). Throws on any
 * other index — an out-of-range token position is an engine invariant break,
 * never a rendering concern.
 */
export function perimeterGridPosition(index: number): GridPosition {
  if (!Number.isInteger(index) || index < 0 || index > 31) {
    throw new Error(`board layout: index ${String(index)} is outside the 32-space loop`);
  }
  if (index <= 8) return { row: 9, col: 9 - index };
  if (index <= 15) return { row: 17 - index, col: 1 };
  if (index <= 24) return { row: 1, col: index - 15 };
  return { row: index - 23, col: 9 };
}

/** The 7×7 center panel's grid placement — rows and columns 2 through 8. */
export const CENTER_PLACEMENT = { gridRow: '2 / span 7', gridColumn: '2 / span 7' } as const;

/** One restrained tint per district — a cell strip, never a fill. */
const DISTRICT_TINTS: Readonly<Record<string, string>> = {
  FOUNDRY_ROW: '#8a5a3c',
  HARBOR_QUARTER: '#3c6a8a',
  MARKETVIEW: '#2f7d6d',
  PARKSIDE: '#476b4a',
  MIDTOWN: '#6a5a8a',
  CROWN_HEIGHTS: '#a3853f',
};

/** The district strip color for a cell, or null for non-district spaces. */
export function districtTint(districtId: string | undefined): string | null {
  if (!districtId) return null;
  return DISTRICT_TINTS[districtId] ?? null;
}
