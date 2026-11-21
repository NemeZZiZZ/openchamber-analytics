/**
 * Pure brush geometry — selection lives in zero-based domain (index) space
 * and maps to pixels exactly once. No double inversion ever happens.
 */

export type BrushSelection = { start: number; end: number };

export const BRUSH_THRESHOLD = 30;
export const BRUSH_WINDOW_SIZE = 30;
export const BRUSH_OVERVIEW_HEIGHT = 32;

export function brushOverviewHeight(): number {
  return BRUSH_OVERVIEW_HEIGHT;
}

export function isBrushVisible(count: number, threshold = BRUSH_THRESHOLD): boolean {
  return count > threshold;
}

/** The latest-window selection: the final `windowSize` buckets. */
export function defaultSelection(count: number, windowSize = BRUSH_WINDOW_SIZE): BrushSelection {
  if (count <= 0) {
    return { start: 0, end: 0 };
  }

  const size = Math.min(windowSize, count);
  return { start: Math.max(0, count - size), end: count - 1 };
}

/** Clamps a selection into the domain and normalizes start ≤ end. */
export function clampSelection(selection: BrushSelection, count: number): BrushSelection {
  const start = Math.min(Math.max(0, Math.floor(selection.start)), Math.max(0, count - 1));
  const end = Math.min(Math.max(0, Math.floor(selection.end)), Math.max(0, count - 1));

  return start <= end ? { start, end } : { start: end, end: start };
}

export type SelectionPixels = { startX: number; endX: number; width: number };

/**
 * Domain → pixel mapping: `x = index / (count - 1) * width`. Applied once;
 * callers never re-invert coordinates.
 */
export function selectionToPixels(selection: BrushSelection, count: number, width: number): SelectionPixels {
  if (count <= 1) {
    return { startX: 0, endX: width, width };
  }

  const denominator = count - 1;
  const startX = (selection.start / denominator) * width;
  const endX = (selection.end / denominator) * width;

  return { startX, endX, width: endX - startX };
}

/** Pixel → nearest index (the single inverse of selectionToPixels). */
export function pixelToIndex(px: number, count: number, width: number): number {
  if (count <= 1 || width <= 0) {
    return 0;
  }

  const ratio = Math.min(Math.max(px / width, 0), 1);
  return Math.round(ratio * (count - 1));
}
