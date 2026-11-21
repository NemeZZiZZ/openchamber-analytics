import type {
  CounterDay,
  CounterEvent,
  CounterKind,
  EventCountersViewModel,
  PeriodBounds,
} from '../shared/analytics-types';
import { listLocalDayKeys, localDayKey } from './time';

const KINDS: readonly CounterKind[] = [
  'executionFailed',
  'executionInterrupted',
  'compaction',
  'retryScheduled',
  'permissionAsked',
  'permissionReplied',
  'permissionWait',
];

function isValidCounter(value: unknown): value is CounterEvent {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<CounterEvent>;
  return typeof candidate.kind === 'string' && KINDS.includes(candidate.kind) && typeof candidate.sessionID === 'string';
}

/**
 * Aggregates stored counters into the snapshot view model. Scope filters by
 * session: an occurrence whose session is not in `scopedSessionIds` counts
 * only in the all-data scope (unknown sessions carry no directory). Days are
 * local to the viewer timezone and zero-filled across the window.
 */
export function buildEventCounters(
  counters: readonly unknown[],
  scopedSessionIds: ReadonlySet<string>,
  scope: 'all' | 'project',
  window: PeriodBounds,
  timeZone: string,
): EventCountersViewModel {
  const totals = { executionFailed: 0, executionInterrupted: 0, compactions: 0, retries: 0, permissionAsks: 0 };
  const daily = new Map<string, CounterDay>();
  let waitSum = 0;
  let waitCount = 0;

  for (const day of listLocalDayKeys(window.startDay, window.endDay, timeZone)) {
    daily.set(day, { day, executionFailed: 0, executionInterrupted: 0, compactions: 0, retries: 0, permissions: 0 });
  }

  for (const entry of counters) {
    if (!isValidCounter(entry)) {
      continue;
    }

    if (scope !== 'all' && !scopedSessionIds.has(entry.sessionID)) {
      continue;
    }

    if (entry.timestamp < window.startMs || entry.timestamp > window.endMs) {
      continue;
    }

    const day = localDayKey(entry.timestamp, timeZone);
    const bucket = daily.get(day);

    if (entry.kind === 'permissionWait') {
      if (typeof entry.ms === 'number' && Number.isFinite(entry.ms) && entry.ms >= 0) {
        waitSum += entry.ms;
        waitCount += 1;
      }

      continue;
    }

    if (bucket === undefined) {
      continue;
    }

    if (entry.kind === 'executionFailed') {
      totals.executionFailed += 1;
      bucket.executionFailed += 1;
    } else if (entry.kind === 'executionInterrupted') {
      totals.executionInterrupted += 1;
      bucket.executionInterrupted += 1;
    } else if (entry.kind === 'compaction') {
      totals.compactions += 1;
      bucket.compactions += 1;
    } else if (entry.kind === 'retryScheduled') {
      totals.retries += 1;
      bucket.retries += 1;
    } else if (entry.kind === 'permissionAsked') {
      totals.permissionAsks += 1;
      bucket.permissions += 1;
    }
    // permissionReplied has no own card; the wait latency carries the value.
  }

  return {
    ...totals,
    avgPermissionWaitMs: waitCount > 0 ? waitSum / waitCount : 0,
    daily: [...daily.values()],
  };
}
