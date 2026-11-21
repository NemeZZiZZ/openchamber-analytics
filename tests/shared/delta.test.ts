import { describe, expect, it } from 'vitest';

import { computeDelta, deltaPercentLabel } from '../../src/shared/delta';

describe('computeDelta', () => {
  it('marks a positive current over an exact zero previous as new', () => {
    const delta = computeDelta(5, 0, 'exact');
    expect(delta.state).toBe('new');
    expect(delta.percent).toBeUndefined();
    expect(delta.capped).toBe(false);
  });

  it('suppresses new when the zero previous period is not exact', () => {
    expect(computeDelta(5, 0, 'estimated').state).toBe('unavailable');
    expect(computeDelta(5, 0, 'partial').state).toBe('unavailable');
    expect(computeDelta(5, 0).state).toBe('unavailable');
  });

  it('treats equal values as flat', () => {
    const delta = computeDelta(12, 12, 'exact');
    expect(delta.state).toBe('flat');
    expect(delta.percent).toBe(0);
    expect(delta.capped).toBe(false);
  });

  it('detects an increase with the rounded percentage', () => {
    const delta = computeDelta(150, 100, 'exact');
    expect(delta.state).toBe('up');
    expect(delta.percent).toBe(50);
    expect(delta.capped).toBe(false);
  });

  it('detects a decrease', () => {
    const delta = computeDelta(75, 100, 'exact');
    expect(delta.state).toBe('down');
    expect(delta.percent).toBe(25);
  });

  it('caps the percentage above 999', () => {
    const delta = computeDelta(100000, 1, 'exact');
    expect(delta.state).toBe('up');
    expect(delta.percent).toBeGreaterThan(999);
    expect(delta.capped).toBe(true);
    expect(deltaPercentLabel(delta)).toBe('999+');
  });

  it('has no delta without a previous period', () => {
    expect(computeDelta(10, undefined, 'exact').state).toBe('unavailable');
    expect(computeDelta(10, undefined).state).toBe('unavailable');
  });

  it('rounds percentages', () => {
    expect(computeDelta(100, 3, 'exact').percent).toBe(3233);
  });
});
