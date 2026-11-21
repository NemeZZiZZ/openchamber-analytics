import { describe, expect, it } from 'vitest';

import type { CounterEvent } from '../../src/shared/analytics-types';
import { buildEventCounters } from '../../src/service/aggregate-counters';
import { createPeriodWindow } from '../../src/service/time';

const NOW = Date.parse('2026-11-20T12:00:00Z');

function counter(kind: CounterEvent['kind'], sessionID: string, timestamp: number, ms?: number): CounterEvent {
  return { kind, sessionID, timestamp, ...(ms === undefined ? {} : { ms }) };
}

describe('buildEventCounters', () => {
  const window = createPeriodWindow('7d', NOW, 'UTC');
  const scoped = new Set(['ses_known']);

  it('buckets counters into zero-filled local days and averages waits', () => {
    const view = buildEventCounters(
      [
        counter('executionFailed', 'ses_known', Date.parse('2026-11-19T09:00:00Z')),
        counter('compaction', 'ses_known', Date.parse('2026-11-19T15:00:00Z')),
        counter('retryScheduled', 'ses_known', Date.parse('2026-11-18T08:00:00Z')),
        counter('permissionAsked', 'ses_known', Date.parse('2026-11-17T08:00:00Z')),
        counter('permissionWait', 'ses_known', Date.parse('2026-11-17T08:05:00Z'), 60_000),
        counter('permissionWait', 'ses_known', Date.parse('2026-11-16T08:05:00Z'), 20_000),
        { kind: 'banana', sessionID: 'ses_known', timestamp: Date.parse('2026-11-15T08:00:00Z') },
        null,
      ],
      scoped,
      'all',
      window,
      'UTC',
    );

    expect(view.executionFailed).toBe(1);
    expect(view.compactions).toBe(1);
    expect(view.retries).toBe(1);
    expect(view.permissionAsks).toBe(1);
    expect(view.avgPermissionWaitMs).toBe(40_000);
    expect(view.daily).toHaveLength(7);
    expect(view.daily[6]?.day).toBe('2026-11-20');
    expect(view.daily[5]).toMatchObject({ day: '2026-11-19', executionFailed: 1, compactions: 1 });
    expect(view.daily[4]).toMatchObject({ day: '2026-11-18', retries: 1 });
    expect(view.daily[3]).toMatchObject({ day: '2026-11-17', permissions: 1 });
    expect(view.daily.every((bucket) => bucket.executionInterrupted === 0)).toBe(true);
  });

  it('drops events outside the window', () => {
    const view = buildEventCounters(
      [
        counter('executionFailed', 'ses_known', Date.parse('2026-10-01T00:00:00Z')),
        counter('executionFailed', 'ses_known', NOW + 60_000),
      ],
      scoped,
      'all',
      window,
      'UTC',
    );

    expect(view.executionFailed).toBe(0);
  });

  it('excludes unknown sessions in project scope but keeps them in all scope', () => {
    const events = [counter('executionFailed', 'ses_other', Date.parse('2026-11-19T09:00:00Z'))];

    expect(buildEventCounters(events, scoped, 'project', window, 'UTC').executionFailed).toBe(0);
    expect(buildEventCounters(events, scoped, 'all', window, 'UTC').executionFailed).toBe(1);
    expect(buildEventCounters(events, new Set(['ses_other']), 'project', window, 'UTC').executionFailed).toBe(1);
  });
});
