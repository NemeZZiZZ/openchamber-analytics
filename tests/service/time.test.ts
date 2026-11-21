import { describe, expect, it } from 'vitest';

import {
  createPeriodWindow,
  listLocalDayKeys,
  localDayKey,
  localMidnightMs,
  localWeekdayHour,
  resolveTimeZone,
} from '../../src/service/time';

describe('resolveTimeZone', () => {
  it('keeps valid IANA zones', () => {
    expect(resolveTimeZone('Europe/Belgrade')).toBe('Europe/Belgrade');
    expect(resolveTimeZone('America/New_York')).toBe('America/New_York');
  });

  it('falls back to UTC for missing or invalid values', () => {
    expect(resolveTimeZone()).toBe('UTC');
    expect(resolveTimeZone('')).toBe('UTC');
    expect(resolveTimeZone('Not/AZone')).toBe('UTC');
    expect(resolveTimeZone('   ')).toBe('UTC');
  });
});

describe('localDayKey', () => {
  it('groups the 2024 New York spring-forward morning into one local day with distinct valid hours', () => {
    const before = Date.parse('2024-03-10T06:30:00Z');
    const after = Date.parse('2024-03-10T07:30:00Z');

    expect(localDayKey(before, 'America/New_York')).toBe('2024-03-10');
    expect(localDayKey(after, 'America/New_York')).toBe('2024-03-10');

    const beforeParts = localWeekdayHour(before, 'America/New_York');
    const afterParts = localWeekdayHour(after, 'America/New_York');

    expect(beforeParts.hour).not.toBe(afterParts.hour);
    // Hour 2 does not exist on this day; both instants must map to valid local hours.
    expect(beforeParts.hour).not.toBe(2);
    expect(afterParts.hour).not.toBe(2);
    expect(beforeParts.hour).toBeGreaterThanOrEqual(0);
    expect(afterParts.hour).toBeLessThanOrEqual(23);
  });

  it('splits one UTC instant into different days for UTC and +14:00 viewers', () => {
    const timestamp = Date.parse('2024-01-01T12:00:00Z');

    expect(localDayKey(timestamp, 'UTC')).toBe('2024-01-01');
    expect(localDayKey(timestamp, 'Pacific/Kiritimati')).toBe('2024-01-02');
  });

  it('assigns weekday with Monday=0 through Sunday=6', () => {
    // 2024-01-01 is a Monday: UTC Monday 23:30, Kiritimati already Tuesday 13:30.
    const timestamp = Date.parse('2024-01-01T23:30:00Z');

    expect(localWeekdayHour(timestamp, 'UTC')).toEqual({ weekday: 0, hour: 23 });
    expect(localWeekdayHour(timestamp, 'Pacific/Kiritimati')).toEqual({ weekday: 1, hour: 13 });
  });
});

describe('listLocalDayKeys', () => {
  it('lists every calendar day across the 2024 spring-forward boundary without fixed-day arithmetic drift', () => {
    expect(listLocalDayKeys('2024-03-09', '2024-03-11', 'America/New_York')).toEqual([
      '2024-03-09',
      '2024-03-10',
      '2024-03-11',
    ]);
  });

  it('returns a single key when start equals end', () => {
    expect(listLocalDayKeys('2026-02-28', '2026-02-28', 'UTC')).toEqual(['2026-02-28']);
  });

  it('includes leap day in a February range', () => {
    const keys = listLocalDayKeys('2024-02-28', '2024-03-01', 'UTC');
    expect(keys).toEqual(['2024-02-28', '2024-02-29', '2024-03-01']);
  });
});

describe('createPeriodWindow', () => {
  // Belgrade on 2026-11-18: DST ends 2026-10-25, so 2026-10-20 is still CEST (+2).
  const now = Date.parse('2026-11-18T12:00:00Z');

  it('builds the 30-day window starting on local 2026-10-20 with the preceding 30 local days', () => {
    const window = createPeriodWindow('30d', now, 'Europe/Belgrade');

    expect(window.startDay).toBe('2026-10-20');
    expect(window.endDay).toBe('2026-11-18');
    expect(window.dayCount).toBe(30);
    expect(window.previous).toBeDefined();
    expect(window.previous?.startDay).toBe('2026-09-20');
    expect(window.previous?.endDay).toBe('2026-10-19');
    expect(window.previous?.dayCount).toBe(30);
  });

  it('carries exact UTC bounds of local midnight', () => {
    const window = createPeriodWindow('30d', now, 'Europe/Belgrade');

    // Local midnight 2026-10-20 CEST = 2026-10-19T22:00:00Z.
    expect(window.startMs).toBe(Date.parse('2026-10-19T22:00:00Z'));
    // Local midnight 2026-11-18 CET = 2026-11-17T23:00:00Z.
    // The previous window ends one millisecond before the current one starts.
    expect(window.previous?.endMs).toBe(Date.parse('2026-10-19T22:00:00Z') - 1);
  });

  it('builds the 7-day and 90-day windows on local calendar boundaries', () => {
    const seven = createPeriodWindow('7d', now, 'Europe/Belgrade');
    expect(seven.startDay).toBe('2026-11-12');
    expect(seven.dayCount).toBe(7);
    expect(seven.previous?.startDay).toBe('2026-11-05');

    const ninety = createPeriodWindow('90d', now, 'Europe/Belgrade');
    expect(ninety.startDay).toBe('2026-08-21');
    expect(ninety.dayCount).toBe(90);
    expect(ninety.previous?.startDay).toBe('2026-05-23');
  });

  it('starts All time at the supplied earliest day with no previous window', () => {
    const earliest = Date.parse('2024-02-29T10:00:00Z');
    const window = createPeriodWindow('all', now, 'Europe/Belgrade', earliest);

    expect(window.startDay).toBe('2024-02-29');
    expect(window.endDay).toBe('2026-11-18');
    expect(window.previous).toBeUndefined();
    expect(window.dayCount).toBeGreaterThan(900);
  });
});

describe('localMidnightMs on DST days without a midnight', () => {
  it.each(['America/Havana', 'America/Santiago', 'America/Asuncion'])('%s stays inside the requested day', (zone) => {
    // Find a day whose midnight is skipped by scanning one year of day keys.
    const days = listLocalDayKeys('2026-01-01', '2026-12-31', zone);

    for (const day of days) {
      const ms = localMidnightMs(day, zone);

      expect(localDayKey(ms, zone)).toBe(day);
      expect(localDayKey(ms - 1, zone) < day).toBe(true);
    }
  });
});
