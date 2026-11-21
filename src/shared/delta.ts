import type { Precision } from './analytics-types';

export type DeltaState = 'new' | 'flat' | 'up' | 'down' | 'unavailable';

export type Delta = {
  state: DeltaState;
  /** Rounded percent change; absent when undefined or when previous is zero. */
  percent?: number;
  /** True when percent exceeds 999 and must display as 999+. */
  capped: boolean;
};

/**
 * Previous-period delta state machine:
 * - previous == 0 and current > 0 → new, but only when the previous period is
 *   exact; a provisional zero previous period shows `—` (unavailable);
 * - equal → flat; greater → up; otherwise → down;
 * - All time (previous undefined) never shows a delta.
 */
export function computeDelta(
  current: number,
  previous: number | undefined,
  previousPrecision?: Precision,
): Delta {
  if (previous === undefined) {
    return { state: 'unavailable', capped: false };
  }

  if (previous === 0) {
    if (current > 0) {
      return previousPrecision === 'exact'
        ? { state: 'new', percent: undefined, capped: false }
        : { state: 'unavailable', capped: false };
    }

    if (current === 0) {
      return { state: 'flat', percent: undefined, capped: false };
    }

    return { state: 'down', percent: undefined, capped: false };
  }

  const rawPercent = Math.round(Math.abs((current - previous) / previous) * 100);

  return {
    state: current === previous ? 'flat' : current > previous ? 'up' : 'down',
    percent: rawPercent,
    capped: rawPercent > 999,
  };
}

/** Percent label for display: 999+ cap, plain percent, or an em dash. */
export function deltaPercentLabel(delta: Delta): string {
  if (delta.state === 'unavailable') {
    return '—';
  }

  if (delta.percent === undefined) {
    return delta.state === 'new' ? 'new' : '—';
  }

  return delta.capped ? '999+' : `${delta.percent}%`;
}
