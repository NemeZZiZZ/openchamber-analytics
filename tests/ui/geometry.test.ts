import { describe, expect, it } from 'vitest';

import {
  attachIdentity,
  capXLabelIndices,
  donutArcs,
  linearTicks,
  linePoints,
  numericMax,
  sharedDomain,
  sparklinePath,
  stackSeries,
  straightLineSegments,
} from '../../src/ui/charts/geometry';

describe('numericMax', () => {
  it('guards empty, zero, negative, NaN, and infinite inputs', () => {
    expect(numericMax([])).toBe(1);
    expect(numericMax([0, 0])).toBe(1);
    expect(numericMax([-5, -2])).toBe(1);
    expect(numericMax([Number.NaN, 5, Number.POSITIVE_INFINITY])).toBe(5);
    expect(numericMax([3])).toBe(3);
    expect(numericMax([0.5, 0.25])).toBeCloseTo(0.5, 9);
  });
});

describe('sharedDomain', () => {
  it('uses one zero-to-maximum scale across series', () => {
    expect(sharedDomain([[1, 2, 3], [10]])).toEqual({ min: 0, max: 10 });
    expect(sharedDomain([[]])).toEqual({ min: 0, max: 1 });
    expect(sharedDomain([[Number.NaN, 4], [Number.NEGATIVE_INFINITY, 8]])).toEqual({ min: 0, max: 8 });
  });
});

describe('linearTicks', () => {
  it('produces monotonic ticks within the domain', () => {
    const ticks = linearTicks(0, 100, 5);
    expect(ticks[0]).toBe(0);
    expect(ticks.at(-1)).toBe(100);
    expect(ticks.length).toBeLessThanOrEqual(6);

    const single = linearTicks(0, 0, 5);
    expect(single).toEqual([0]);
  });
});

describe('stackSeries', () => {
  it('stacks additively so totals reconcile', () => {
    const result = stackSeries([
      { key: 'a', points: [1, 2] },
      { key: 'b', points: [3, 4] },
    ]);

    expect(result.keys).toEqual(['a', 'b']);
    expect(result.totals).toEqual([4, 6]);
    // Cumulative tops: a tops [1,2]; b tops [4,6].
    expect(result.tops).toEqual([[1, 2], [4, 6]]);
    expect(result.bases).toEqual([[0, 0], [1, 2]]);
  });

  it('treats NaN and infinite values as zero without corrupting totals', () => {
    const result = stackSeries([
      { key: 'a', points: [Number.NaN, 2] },
      { key: 'b', points: [Number.POSITIVE_INFINITY, 3] },
    ]);

    expect(result.totals).toEqual([0, 5]);
  });

  it('handles ragged series by padding with zeros', () => {
    const result = stackSeries([
      { key: 'a', points: [1] },
      { key: 'b', points: [2, 3] },
    ]);

    expect(result.totals).toEqual([3, 3]);
  });
});

describe('capXLabelIndices', () => {
  it('caps labels at roughly eight while keeping start and end context', () => {
    for (const count of [1, 7, 8, 9, 30, 90, 400]) {
      const indices = capXLabelIndices(count);

      expect(indices.length).toBeLessThanOrEqual(8);
      expect(indices[0]).toBe(0);
      expect(indices.at(-1)).toBe(count - 1);

      for (const index of indices) {
        expect(index).toBeGreaterThanOrEqual(0);
        expect(index).toBeLessThan(count);
      }
    }
  });

  it('keeps every label for small counts', () => {
    expect(capXLabelIndices(5)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('linePoints and straightLineSegments', () => {
  it('maps values to straight-segment points inside bounds', () => {
    const points = linePoints([0, 10, 5], 100, 50, { min: 0, max: 10 });

    expect(points).toHaveLength(3);
    expect(points[0]).toEqual({ x: 0, y: 50 });
    expect(points[1]).toEqual({ x: 50, y: 0 });
    expect(points[2]?.y).toBeGreaterThan(0);
    expect(points[2]?.y).toBeLessThan(50);
  });

  it('guards single and empty series', () => {
    expect(linePoints([], 100, 50, { min: 0, max: 1 })).toEqual([]);
    const single = linePoints([7], 100, 50, { min: 0, max: 7 });
    expect(single).toHaveLength(1);
    expect(single[0]?.y).toBe(0);
  });

  it('produces straight segments between consecutive points', () => {
    const segments = straightLineSegments([0, 10, 5], 90, 50, { min: 0, max: 10 });
    expect(segments).toHaveLength(2);
  });
});

describe('sparklinePath', () => {
  it('stays within the requested bounds', () => {
    const path = sparklinePath([0, 5, 10, 3], 80, 24, { min: 0, max: 10 });

    expect(path.startsWith('M')).toBe(true);
    expect(path).not.toContain('NaN');
    // Bounds: y between 0 and 24, x between 0 and 80.
    const coordinates = path.match(/[\d.]+/g)?.map(Number) ?? [];
    for (let index = 0; index < coordinates.length; index += 2) {
      expect(coordinates[index]).toBeGreaterThanOrEqual(0);
      expect(coordinates[index]).toBeLessThanOrEqual(80);
      expect(coordinates[index + 1]).toBeGreaterThanOrEqual(0);
      expect(coordinates[index + 1]).toBeLessThanOrEqual(24);
    }
  });

  it('handles flat and empty series', () => {
    expect(sparklinePath([], 80, 24, { min: 0, max: 1 })).toBe('');
    expect(sparklinePath([0, 0], 80, 24, { min: 0, max: 1 })).not.toContain('NaN');
  });
});

describe('donutArcs', () => {
  it('sums fractions to exactly one', () => {
    const arcs = donutArcs([3, 2, 1]);
    const sum = arcs.reduce((acc, arc) => acc + arc.fraction, 0);

    expect(sum).toBeCloseTo(1, 12);
    expect(arcs).toHaveLength(3);
    expect(arcs[0]?.fraction).toBeCloseTo(0.5, 12);
  });

  it('handles zero and single-value inputs', () => {
    expect(donutArcs([0, 0])).toHaveLength(0);
    expect(donutArcs([5])[0]?.fraction).toBe(1);
    expect(donutArcs([Number.NaN, 4])[0]?.fraction).toBe(1);
  });
});

describe('attachIdentity', () => {
  it('preserves source series identity through sorting', () => {
    const models = [
      { key: 'zai/glm-5', tokens: 100 },
      { key: 'zai/glm-6', tokens: 200 },
      { key: 'openai/gpt-5', tokens: 50 },
    ];

    const withIdentity = attachIdentity(models);
    expect(withIdentity.map((model) => model.seriesIndex)).toEqual([0, 1, 2]);

    const sorted = [...withIdentity].sort((a, b) => b.tokens - a.tokens);
    // Sorted order carries the ORIGINAL series index, never the row index.
    expect(sorted.map((model) => model.seriesIndex)).toEqual([1, 0, 2]);
    expect(sorted[0]?.key).toBe('zai/glm-6');
    expect(sorted[0]?.seriesIndex).toBe(1);
  });
});
