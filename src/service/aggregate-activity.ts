import type { ActivityDayCell, ActivityViewModel, PeriodBounds, RhythmCell, UsageEvent } from '../shared/analytics-types';
import { eventTokens } from '../shared/analytics-types';
import { formatCompactNumber, formatDayShort } from '../shared/formatting';
import { listLocalDayKeys, localDayKey, localWeekdayHour, shiftDayKeyBack } from './time';

const GRID_DAY_SPAN = 364;
const WEEKDAY_NAMES = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;

/** Intensity ramp 0–4 relative to the largest visible value (spec §7.7). */
function intensityLevel(value: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (value <= 0 || max <= 0) {
    return 0;
  }

  return Math.min(4, Math.max(1, Math.ceil((value / max) * 4))) as 0 | 1 | 2 | 3 | 4;
}

/**
 * The last-12-month activity grid: every local calendar day from the Monday
 * at least 364 days back through today, Monday-first, levels relative to the
 * grid maximum. The grid is independent of the selected period window.
 */
/** Tokens per local calendar day over every passed event. */
export function tokensByLocalDay(events: UsageEvent[], timeZone: string): Map<string, number> {
  const tokensByDay = new Map<string, number>();

  for (const event of events) {
    const day = localDayKey(event.timestamp, timeZone);
    tokensByDay.set(day, (tokensByDay.get(day) ?? 0) + eventTokens(event));
  }

  return tokensByDay;
}

export type ActivityOptions = {
  /** Precomputed `tokensByLocalDay(events, timeZone)`. */
  tokensByDay?: Map<string, number>;
  /** Period averages already computed by the summary over the same window. */
  averages?: { total: number; avgPerActiveDay: number; avgPerWeek: number };
};

export function buildActivity(
  events: UsageEvent[],
  now: number,
  timeZone: string,
  window: PeriodBounds,
  options: ActivityOptions = {},
): ActivityViewModel {
  const endDay = localDayKey(now, timeZone);
  const gridStart = shiftDayKeyBack(endDay, GRID_DAY_SPAN);
  const gridStartWeekday = new Date(`${gridStart}T12:00:00Z`).getUTCDay();
  // JS getUTCDay: Sunday=0 … Saturday=6; Monday-first alignment.
  const backToMonday = (gridStartWeekday + 6) % 7;
  const alignedStart = shiftDayKeyBack(gridStart, backToMonday);

  const dayKeys = listLocalDayKeys(alignedStart, endDay, timeZone);
  const tokensByDay = options.tokensByDay ?? tokensByLocalDay(events, timeZone);

  const cellValues = dayKeys.map((day) => ({ day, tokens: tokensByDay.get(day) ?? 0 }));
  const max = cellValues.reduce((acc, cell) => Math.max(acc, cell.tokens), 0);

  const cells: ActivityDayCell[] = cellValues.map((cell) => ({
    day: cell.day,
    tokens: cell.tokens,
    level: intensityLevel(cell.tokens, max),
    label: `${cell.day}: ${formatCompactNumber(cell.tokens)} tokens`,
  }));

  const averages = options.averages ?? windowAvgTokens(events, window, timeZone);

  return {
    cells,
    longestStreak: longestStreak(dayKeys, tokensByDay),
    avgTokensPerActiveDay: averages.avgPerActiveDay,
    avgTokensPerWeek: averages.avgPerWeek,
    totalTokens: averages.total,
  };
}

function windowAvgTokens(
  events: UsageEvent[],
  window: PeriodBounds,
  timeZone: string,
): { total: number; avgPerActiveDay: number; avgPerWeek: number } {
  let total = 0;
  const activeDays = new Set<string>();

  for (const event of events) {
    if (event.timestamp < window.startMs || event.timestamp > window.endMs) {
      continue;
    }

    total += eventTokens(event);
    activeDays.add(localDayKey(event.timestamp, timeZone));
  }

  const weeks = Math.max(1, Math.ceil(window.dayCount / 7));

  return {
    total,
    avgPerActiveDay: activeDays.size === 0 ? 0 : total / activeDays.size,
    avgPerWeek: total / weeks,
  };
}

function longestStreak(dayKeys: string[], tokensByDay: Map<string, number>): number {
  let longest = 0;
  let current = 0;

  for (const day of dayKeys) {
    if ((tokensByDay.get(day) ?? 0) > 0) {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }

  return longest;
}

/**
 * Activity Rhythm: tokens summed into 7 local weekdays × 24 local hours over
 * the windowed event set. Every cell carries its intensity level, a label
 * with weekday, the dates it covers, and the formatted token value.
 */
export function buildActivityRhythm(
  events: UsageEvent[],
  window: PeriodBounds,
  timeZone: string,
  /** Presentation locale for the covered-date range; defaults to the host locale. */
  locale?: string,
): RhythmCell[] {
  const values = new Map<string, number>();

  for (const event of events) {
    if (event.timestamp < window.startMs || event.timestamp > window.endMs) {
      continue;
    }

    const { weekday, hour } = localWeekdayHour(event.timestamp, timeZone);
    const key = `${weekday}:${hour}`;
    values.set(key, (values.get(key) ?? 0) + eventTokens(event));
  }

  // Which calendar dates each weekday covers: a rhythm cell aggregates every
  // matching day of the window, and the tooltip must name them.
  const dayKeys = listLocalDayKeys(window.startDay, window.endDay, timeZone);
  const datesByWeekday = new Map<number, string>();
  const dayKeysByWeekday = new Map<number, string[]>();

  for (const day of dayKeys) {
    const weekday = weekdayOfDayKey(day);
    const keys = dayKeysByWeekday.get(weekday) ?? [];
    keys.push(day);
    dayKeysByWeekday.set(weekday, keys);
  }

  for (const [weekday, keys] of dayKeysByWeekday) {
    const first = formatDayShort(keys[0] ?? '', locale);
    const last = formatDayShort(keys[keys.length - 1] ?? '', locale);
    datesByWeekday.set(weekday, first === last ? first : `${first} – ${last}`);
  }

  const cells: RhythmCell[] = [];

  for (let weekday = 0; weekday < 7; weekday += 1) {
    for (let hour = 0; hour < 24; hour += 1) {
      const tokens = values.get(`${weekday}:${hour}`) ?? 0;
      const dates = datesByWeekday.get(weekday);
      cells.push({
        weekday,
        hour,
        tokens,
        level: 0,
        label: '',
        ...(dates === undefined ? {} : { dates }),
      });
    }
  }

  const max = cells.reduce((acc, cell) => Math.max(acc, cell.tokens), 0);

  for (const cell of cells) {
    cell.level = intensityLevel(cell.tokens, max);
    const dates = cell.dates === undefined ? '' : `, ${cell.dates}`;
    cell.label = `${WEEKDAY_NAMES[cell.weekday]}${dates} · ${String(cell.hour).padStart(2, '0')}:00 — ${formatCompactNumber(cell.tokens)} tokens`;
  }

  return cells;
}

/** Calendar weekday (0=Monday … 6=Sunday) of a local day key; TZ-independent. */
function weekdayOfDayKey(day: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);

  if (!match) {
    return 0;
  }

  const utcNoon = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
  return (new Date(utcNoon).getUTCDay() + 6) % 7;
}
