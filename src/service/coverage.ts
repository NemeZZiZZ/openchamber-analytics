import type {
  AnalyticsFilters,
  AnalyticsSurface,
  Coverage,
  Precision,
  PeriodBounds,
  StoredSessionAnalytics,
} from '../shared/analytics-types';
import { eventTokens } from '../shared/analytics-types';
import { createPeriodWindow, localDayKey } from './time';
import { scopeRecords } from './scope';

const YEAR_GRID_DAYS = 364;
const DAY_MS = 86_400_000;

export type CoverageResult = Coverage & {
  precision: Precision;
  periodPrecision: {
    current: Precision;
    previous?: Precision;
  };
};

export type CoverageOptions = {
  /** False while the initial session-list bootstrap is still in flight. */
  sessionListComplete?: boolean;
};

/** Earliest known activity (session creation or event) among the given records. */
export function earliestKnownActivity(records: StoredSessionAnalytics[]): number | undefined {
  let earliest: number | undefined;

  const consider = (candidate: number): void => {
    if (Number.isFinite(candidate) && (earliest === undefined || candidate < earliest)) {
      earliest = candidate;
    }
  };

  for (const record of records) {
    consider(record.session.timeCreated);

    for (const event of record.events) {
      consider(event.timestamp);
    }
  }

  return earliest;
}

/**
 * Best-known activity bounds of a session: detailed event timestamps once
 * complete data exists, conservative session timestamps while coverage is
 * unresolved.
 */
function activityBounds(record: StoredSessionAnalytics): { start: number; end: number } {
  if (record.state === 'complete' && record.events.length > 0) {
    let start = Number.POSITIVE_INFINITY;
    let end = 0;

    for (const event of record.events) {
      start = Math.min(start, event.timestamp);
      end = Math.max(end, event.timestamp);
    }

    return { start, end };
  }

  return { start: record.session.timeCreated, end: record.session.timeUpdated };
}

function intersects(bounds: { start: number; end: number }, window: PeriodBounds): boolean {
  return bounds.start <= window.endMs && bounds.end >= window.startMs;
}

function machine(
  relevant: StoredSessionAnalytics[],
  bounds: PeriodBounds,
  sessionListComplete: boolean,
): Precision {
  let pending = 0;
  let failed = 0;
  let mismatch = 0;
  let residual = 0;
  let withAssistant = 0;

  for (const record of relevant) {
    const eventBounds = activityBounds(record);
    const touches = intersects(eventBounds, bounds);

    if (record.state === 'pending') {
      if (touches) {
        pending += 1;
      }

      continue;
    }

    if (record.state === 'failed') {
      if (touches) {
        failed += 1;
      }

      continue;
    }

    if (record.state === 'mismatch') {
      if (touches) {
        mismatch += 1;
      }

      continue;
    }

    // Complete session: count residual allocations inside the window and
    // usable assistant-message events.
    let hasAssistant = false;
    let hasResidual = false;

    for (const event of record.events) {
      if (event.timestamp < bounds.startMs || event.timestamp > bounds.endMs) {
        continue;
      }

      if (event.source === 'assistant') {
        hasAssistant = true;
      } else if (event.source === 'residual' && (eventTokens(event) > 0 || event.cost > 0)) {
        hasResidual = true;
      }
    }

    if (hasAssistant) {
      withAssistant += 1;
    }

    if (hasResidual && touches) {
      residual += 1;
    }
  }

  if (!sessionListComplete) {
    // The session list may still grow: unresolved coverage can never be exact.
    return withAssistant > 0 ? 'partial' : 'estimated';
  }

  if (relevant.length === 0) {
    // Authoritatively empty relevant set.
    return 'exact';
  }

  const blocking = pending + failed + mismatch;

  if (blocking > 0) {
    return withAssistant > 0 ? 'partial' : 'estimated';
  }

  if (residual > 0) {
    return 'partial';
  }

  return 'exact';
}

function coverageCounters(relevant: StoredSessionAnalytics[], bounds: PeriodBounds): Coverage {
  let complete = 0;
  let residual = 0;
  let pending = 0;
  let failed = 0;
  let mismatch = 0;

  for (const record of relevant) {
    const eventBounds = activityBounds(record);
    const touches = intersects(eventBounds, bounds);

    switch (record.state) {
      case 'complete':
        complete += 1;

        if (
          record.events.some(
            (event) =>
              event.source === 'residual' &&
              event.timestamp >= bounds.startMs &&
              event.timestamp <= bounds.endMs &&
              (eventTokens(event) > 0 || event.cost > 0),
          )
        ) {
          residual += 1;
        }

        break;
      case 'pending':
        if (touches) {
          pending += 1;
        }

        break;
      case 'failed':
        if (touches) {
          failed += 1;
        }

        break;
      case 'mismatch':
        if (touches) {
          mismatch += 1;
        }

        break;
    }
  }

  return {
    complete,
    residual,
    pending,
    failed,
    mismatch,
    total: relevant.length,
  };
}

/**
 * Coverage and precision over the relevant session set: sessions whose
 * activity may intersect the union of the selected period, the comparison
 * period, the last-12-month grid (full page only), and all known history for
 * All time. Precision follows the spec §7.4.1 state machine and is computed
 * separately for the current period, the previous period, and the whole
 * snapshot.
 */
export function computeCoverage(
  records: StoredSessionAnalytics[],
  filters: AnalyticsFilters,
  surface: AnalyticsSurface,
  now: number,
  timeZone: string,
  options: CoverageOptions = {},
): CoverageResult {
  const sessionListComplete = options.sessionListComplete ?? true;
  const scoped = scopeRecords(records, filters);
  const window = createPeriodWindow(filters.range, now, timeZone, earliestKnownActivity(scoped));

  // The whole-snapshot union of represented windows.
  const unionStartCandidates: number[] = [window.startMs];
  const unionEndCandidates: number[] = [now];

  if (filters.range !== 'all' && window.previous) {
    unionStartCandidates.push(window.previous.startMs);
    unionEndCandidates.push(window.previous.endMs);
  }

  if (filters.range !== 'all' && surface === 'page') {
    // The full page displays the last-12-month grid.
    unionStartCandidates.push(now - YEAR_GRID_DAYS * DAY_MS);
  }

  if (filters.range === 'all') {
    // All known history is represented: every session is relevant.
    for (const record of scoped) {
      const bounds = activityBounds(record);
      unionStartCandidates.push(bounds.start);
      unionEndCandidates.push(bounds.end);
    }
  }

  const union: PeriodBounds = {
    startDay: localDayKey(Math.min(...unionStartCandidates), timeZone),
    endDay: localDayKey(now, timeZone),
    startMs: Math.min(...unionStartCandidates),
    endMs: Math.max(...unionEndCandidates),
    dayCount: 0,
  };

  const relevant = scoped.filter((record) => intersects(activityBounds(record), union));

  const coverage = coverageCounters(relevant, union);
  const precision = machine(relevant, union, sessionListComplete);

  const periodPrecision: CoverageResult['periodPrecision'] = {
    current: machine(relevant, window, sessionListComplete),
  };

  if (filters.range !== 'all' && window.previous) {
    periodPrecision.previous = machine(relevant, window.previous, sessionListComplete);
  }

  // Align the whole-snapshot counters with the union window.
  return { ...coverage, precision, periodPrecision };
}
