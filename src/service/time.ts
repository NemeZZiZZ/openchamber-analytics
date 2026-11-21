import type { AnalyticsRange, PeriodWindow } from '../shared/analytics-types';

const DAY_MS = 86_400_000;

const WEEKDAY_INDEX: Record<string, number> = {
  Mon: 0,
  Tue: 1,
  Wed: 2,
  Thu: 3,
  Fri: 4,
  Sat: 5,
  Sun: 6,
};

export { resolveTimeZone } from '../shared/timezone';

/** Splits a local YYYY-MM-DD day key into numeric parts. */
function parseDayKey(day: string): { year: number; month: number; dayOfMonth: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);

  if (!match) {
    throw new Error(`invalid local day key: ${day}`);
  }

  return {
    year: Number(match[1]),
    month: Number(match[2]),
    dayOfMonth: Number(match[3]),
  };
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function dayKeyFromParts(year: number, month: number, dayOfMonth: number): string {
  return `${year}-${pad(month)}-${pad(dayOfMonth)}`;
}

// Shared formatters: Intl construction is expensive; reuse per timezone via cache.
const dayKeyFormatterCache = new Map<string, Intl.DateTimeFormat>();
const partsFormatterCache = new Map<string, Intl.DateTimeFormat>();

// Zone offsets are multiples of 15 minutes, so the local day, weekday and hour
// are constant inside one UTC quarter-hour; memoize at that granularity.
const MEMO_BUCKET_MS = 900_000;
const MEMO_LIMIT = 200_000;
// Callers choose the timezone, so every per-zone cache is bounded: the oldest
// zone is evicted once more than this many distinct zones are in use.
const ZONE_CACHE_LIMIT = 8;

function rememberZone<T>(cache: Map<string, T>, timeZone: string, value: T): void {
  if (cache.size >= ZONE_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;

    if (oldest !== undefined) {
      cache.delete(oldest);
    }
  }

  cache.set(timeZone, value);
}
const dayKeyMemo = new Map<string, Map<number, string>>();
const weekdayHourMemo = new Map<string, Map<number, { weekday: number; hour: number }>>();

function dayKeyFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = dayKeyFormatterCache.get(timeZone);

  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      calendar: 'gregory',
    });
    rememberZone(dayKeyFormatterCache, timeZone, formatter);
  }

  return formatter;
}

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = partsFormatterCache.get(timeZone);

  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      hour: 'numeric',
      hourCycle: 'h23',
      calendar: 'gregory',
    });
    rememberZone(partsFormatterCache, timeZone, formatter);
  }

  return formatter;
}

/** The viewing viewer's local calendar day for a UTC timestamp: YYYY-MM-DD. */
export function localDayKey(timestamp: number, timeZone: string): string {
  // Memoizing per quarter-hour avoids one Intl call per event.
  const minute = Math.floor(timestamp / MEMO_BUCKET_MS);
  let memo = dayKeyMemo.get(timeZone);

  if (!memo) {
    memo = new Map();
    rememberZone(dayKeyMemo, timeZone, memo);
  }

  const hit = memo.get(minute);

  if (hit !== undefined) {
    return hit;
  }

  if (memo.size >= MEMO_LIMIT) {
    memo.clear();
  }

  // en-CA formats as YYYY-MM-DD directly.
  const formatted = dayKeyFormatter(timeZone).format(new Date(timestamp));
  memo.set(minute, formatted);
  return formatted;
}

/** Monday=0 … Sunday=6 local weekday plus the 0–23 local hour. */
export function localWeekdayHour(timestamp: number, timeZone: string): { weekday: number; hour: number } {
  const minute = Math.floor(timestamp / MEMO_BUCKET_MS);
  let memo = weekdayHourMemo.get(timeZone);

  if (!memo) {
    memo = new Map();
    rememberZone(weekdayHourMemo, timeZone, memo);
  }

  const hit = memo.get(minute);

  if (hit !== undefined) {
    return hit;
  }

  if (memo.size >= MEMO_LIMIT) {
    memo.clear();
  }

  const result = computeWeekdayHour(timestamp, timeZone);
  memo.set(minute, result);
  return result;
}

function computeWeekdayHour(timestamp: number, timeZone: string): { weekday: number; hour: number } {
  const parts = partsFormatter(timeZone).formatToParts(new Date(timestamp));
  let weekday = 0;
  let hour = 0;

  for (const part of parts) {
    if (part.type === 'weekday') {
      weekday = WEEKDAY_INDEX[part.value] ?? 0;
    } else if (part.type === 'hour') {
      hour = Number(part.value) % 24;
    }
  }

  return { weekday, hour };
}

/**
 * Enumerates consecutive local calendar day keys from startDay through endDay
 * inclusive. Stepping happens on the pure calendar (UTC-noon representation),
 * so DST transitions in the viewing timezone never skip or repeat a day.
 */
export function listLocalDayKeys(startDay: string, endDay: string, timeZone: string): string[] {
  void timeZone;

  const start = parseDayKey(startDay);
  const end = parseDayKey(endDay);
  const startNoon = Date.UTC(start.year, start.month - 1, start.dayOfMonth, 12);
  const endNoon = Date.UTC(end.year, end.month - 1, end.dayOfMonth, 12);

  if (endNoon < startNoon) {
    return [];
  }

  const keys: string[] = [];

  for (let noon = startNoon; noon <= endNoon; noon += DAY_MS) {
    const date = new Date(noon);
    keys.push(dayKeyFromParts(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()));
  }

  return keys;
}

/** Shifts a local YYYY-MM-DD day key by whole calendar days (negative goes back). */
export function shiftDayKeyBack(day: string, days: number): string {
  const { year, month, dayOfMonth } = parseDayKey(day);
  const noon = Date.UTC(year, month - 1, dayOfMonth, 12) - days * DAY_MS;
  const date = new Date(noon);
  return dayKeyFromParts(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

/** Offset (ms) the viewing timezone is ahead of UTC at the given instant. */
const offsetFormatterCache = new Map<string, Intl.DateTimeFormat>();

function offsetFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = offsetFormatterCache.get(timeZone);

  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      calendar: 'gregory',
    });
    rememberZone(offsetFormatterCache, timeZone, formatter);
  }

  return formatter;
}

function timeZoneOffsetMs(timeZone: string, timestampMs: number): number {
  const parts = offsetFormatter(timeZone).formatToParts(new Date(timestampMs));

  const values: Record<string, number> = {};

  for (const part of parts) {
    if (part.type !== 'literal') {
      values[part.type] = Number(part.value);
    }
  }

  const asUtc = Date.UTC(
    values.year ?? 1970,
    (values.month ?? 1) - 1,
    values.day ?? 1,
    values.hour ?? 0,
    values.minute ?? 0,
    values.second ?? 0,
  );

  return asUtc - Math.floor(timestampMs / 1000) * 1000;
}

/**
 * The first UTC instant that belongs to the local day. Usually that is local
 * midnight; on a DST day where midnight does not exist (clocks jump over it)
 * it is the first instant after the jump, so the instant is always inside the
 * requested day and never in the previous one.
 */
export function localMidnightMs(day: string, timeZone: string): number {
  const { year, month, dayOfMonth } = parseDayKey(day);
  const guess = Date.UTC(year, month - 1, dayOfMonth, 0, 0, 0);
  const offset = timeZoneOffsetMs(timeZone, guess);
  let result = guess - offset;

  const refined = timeZoneOffsetMs(timeZone, result);

  if (refined !== offset) {
    result = guess - refined;
  }

  if (localDayKey(result, timeZone) === day && localDayKey(result - 1, timeZone) !== day) {
    return result;
  }

  // Midnight is skipped or ambiguous: search the surrounding window for the
  // first instant whose local day key is `day`.
  let low = guess - 36 * 3_600_000;
  let high = guess + 36 * 3_600_000;

  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);

    if (localDayKey(mid, timeZone) < day) {
      low = mid;
    } else {
      high = mid;
    }
  }

  return high;
}

const RANGE_DAY_COUNT: Record<Exclude<AnalyticsRange, 'all'>, number> = {
  '1d': 1,
  '7d': 7,
  '30d': 30,
  '90d': 90,
};

/**
 * Builds a period window on local calendar boundaries:
 * - N-day ranges: start of today minus (N-1) local days through now, plus the
 *   immediately preceding N local days as the comparison window;
 * - All time: earliest available activity through now, without a previous window.
 */
export function createPeriodWindow(
  range: AnalyticsRange,
  now: number,
  timeZone: string,
  earliest?: number,
): PeriodWindow {
  const endDay = localDayKey(now, timeZone);

  if (range === 'all') {
    const startDay = earliest === undefined ? endDay : localDayKey(earliest, timeZone);
    const dayKeys = listLocalDayKeys(startDay, endDay, timeZone);

    return {
      range,
      startDay,
      endDay,
      startMs: localMidnightMs(startDay, timeZone),
      endMs: now,
      dayCount: dayKeys.length,
    };
  }

  const dayCount = RANGE_DAY_COUNT[range];
  const startDay = shiftDayKeyBack(endDay, dayCount - 1);
  const startMs = localMidnightMs(startDay, timeZone);
  const previousEndDay = shiftDayKeyBack(startDay, 1);
  const previousStartDay = shiftDayKeyBack(previousEndDay, dayCount - 1);

  return {
    range,
    startDay,
    endDay,
    startMs,
    endMs: now,
    dayCount,
    previous: {
      startDay: previousStartDay,
      endDay: previousEndDay,
      startMs: localMidnightMs(previousStartDay, timeZone),
      // Exclusive of the current window's first instant: no millisecond is
      // counted in both periods.
      endMs: startMs - 1,
      dayCount,
    },
  };
}
