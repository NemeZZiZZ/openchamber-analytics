import { describe, expect, it } from 'vitest';

import {
  brushOverviewHeight,
  clampSelection,
  defaultSelection,
  isBrushVisible,
  pixelToIndex,
  selectionToPixels,
} from '../../src/ui/charts/brush-geometry';

describe('isBrushVisible', () => {
  it('hides at 30 buckets and shows above the threshold', () => {
    expect(isBrushVisible(30)).toBe(false);
    expect(isBrushVisible(31)).toBe(true);
    expect(isBrushVisible(400)).toBe(true);
  });
});

describe('defaultSelection', () => {
  it('selects the latest 30 buckets', () => {
    expect(defaultSelection(90)).toEqual({ start: 60, end: 89 });
    expect(defaultSelection(31)).toEqual({ start: 1, end: 30 });
    expect(defaultSelection(20)).toEqual({ start: 0, end: 19 });
    expect(defaultSelection(0)).toEqual({ start: 0, end: 0 });
  });
});

describe('clampSelection', () => {
  it('clamps to the domain and normalizes order', () => {
    expect(clampSelection({ start: -5, end: 1000 }, 90)).toEqual({ start: 0, end: 89 });
    expect(clampSelection({ start: 50, end: 20 }, 90)).toEqual({ start: 20, end: 50 });
    expect(clampSelection({ start: 10, end: 10 }, 90)).toEqual({ start: 10, end: 10 });
    expect(clampSelection({ start: 0, end: 0 }, 90)).toEqual({ start: 0, end: 0 });
  });
});

describe('selectionToPixels', () => {
  it('maps domain indices to pixels exactly once', () => {
    const pixels = selectionToPixels({ start: 3, end: 7 }, 90, 300);

    // x = index / (count - 1) * width — one inversion only.
    expect(pixels.startX).toBeCloseTo((3 / 89) * 300, 6);
    expect(pixels.endX).toBeCloseTo((7 / 89) * 300, 6);
    expect(pixels.width).toBeCloseTo(((7 - 3) / 89) * 300, 6);
  });

  it('covers the full width for a full-domain selection', () => {
    const pixels = selectionToPixels({ start: 0, end: 89 }, 90, 300);
    expect(pixels.startX).toBe(0);
    expect(pixels.endX).toBe(300);
  });
});

describe('pixelToIndex', () => {
  it('rounds to the nearest bucket index', () => {
    expect(pixelToIndex(0, 90, 300)).toBe(0);
    expect(pixelToIndex(300, 90, 300)).toBe(89);
    expect(pixelToIndex(150, 90, 300)).toBe(Math.round((150 / 300) * 89));
    expect(pixelToIndex(-50, 90, 300)).toBe(0);
    expect(pixelToIndex(9999, 90, 300)).toBe(89);
  });
});

describe('brushOverviewHeight', () => {
  it('is exactly 32 pixels', () => {
    expect(brushOverviewHeight()).toBe(32);
  });
});
