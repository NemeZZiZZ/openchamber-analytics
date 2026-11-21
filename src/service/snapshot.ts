import type {
  AgentAggregate,
  AnalyticsFilters,
  AnalyticsSnapshot,
  StoredSessionAnalytics,
  UsageEvent,
} from '../shared/analytics-types';
import { buildActivity, buildActivityRhythm, tokensByLocalDay } from './aggregate-activity';
import { aggregateSummary, eventModelKey } from './aggregate-core';
import { buildDailyBuckets, computeEfficiency } from './aggregate-daily';
import { listProjects } from './aggregate-projects';
import { aggregateModels, buildPrimaryModelSessionDonut, rankTopProjects, rankTopSessions, TOP_PROJECTS_LIMIT, TOP_SESSIONS_LIMIT } from './aggregate-models';
import { computeBurn, computeQuality } from './aggregate-quality';
import { buildEventCounters } from './aggregate-counters';
import { computeCoverage, earliestKnownActivity } from './coverage';
import { eventTokens } from '../shared/analytics-types';
import { scopeRecords } from './scope';
import { createPeriodWindow, localDayKey, resolveTimeZone } from './time';

/** Room for every model plus its variant tiers; rows are ~200 bytes. */
export const MODELS_LIMIT = 512;
export const AGENTS_LIMIT = 64;

export type BuildSnapshotInput = {
  filters: AnalyticsFilters;
  revision: number;
  now: number;
  records: StoredSessionAnalytics[];
  /** Persisted stream counters (session errors, compactions, permissions). */
  counters?: readonly unknown[];
  /** False while the initial session-list bootstrap is still in flight. */
  sessionListComplete?: boolean;
};

function aggregateAgents(events: UsageEvent[]): AgentAggregate[] {
  const buckets = new Map<string, { tokens: number; cost: number; sessions: Set<string> }>();

  for (const event of events) {
    const agent = event.agent ?? 'unknown';
    const bucket = buckets.get(agent) ?? { tokens: 0, cost: 0, sessions: new Set<string>() };
    bucket.tokens += eventTokens(event);
    bucket.cost += event.cost;
    bucket.sessions.add(event.sessionId);
    buckets.set(agent, bucket);
  }

  return [...buckets.entries()]
    .map(([agent, bucket]) => ({
      agent,
      tokens: bucket.tokens,
      cost: bucket.cost,
      sessions: bucket.sessions.size,
    }))
    .sort((a, b) => b.tokens - a.tokens || a.agent.localeCompare(b.agent))
    .slice(0, AGENTS_LIMIT);
}

/**
 * Cache identity for one snapshot request. The browser timezone participates
 * because daily/hourly aggregates are computed per effective timezone and must
 * never be reused across timezones.
 */
export function snapshotCacheKey(filters: AnalyticsFilters, now?: number): string {
  const timeZone = resolveTimeZone(filters.timeZone);

  return JSON.stringify([
    now === undefined ? '' : localDayKey(now, timeZone),
    filters.scope,
    filters.directory ?? '',
    filters.range,
    filters.surface,
    timeZone,
  ]);
}

/**
 * Builds the complete analytics snapshot from stored numeric allocations.
 * Every chart's tokens/cost reconcile with the summary over the same events
 * and filters; model/session lists are capped well below the host response
 * cap; no raw events or messages leave the service.
 */
export function buildAnalyticsSnapshot(input: BuildSnapshotInput): AnalyticsSnapshot {
  const timeZone = resolveTimeZone(input.filters.timeZone);
  const filters: AnalyticsFilters = { ...input.filters, timeZone };
  const records = scopeRecords(input.records, filters);
  const events = records.flatMap((record) => record.events);

  const earliest = earliestKnownActivity(records);
  const window = createPeriodWindow(filters.range, input.now, timeZone, earliest);

  const periodEvents = events.filter(
    (event) => event.timestamp >= window.startMs && event.timestamp <= window.endMs,
  );

  const sessionRecords = records.map((record) => record.session);
  const tokensByDay = tokensByLocalDay(events, timeZone);
  const summary = aggregateSummary(events, window, timeZone, sessionRecords, { tokensByDay });
  const daily = buildDailyBuckets(events, window, timeZone);
  const previous = window.previous ? aggregateSummary(events, window.previous, timeZone, sessionRecords, { streak: false }) : undefined;

  const coverage = computeCoverage(input.records, filters, filters.surface, input.now, timeZone, {
    sessionListComplete: input.sessionListComplete,
  });

  const periodPrecision = {
    current: coverage.periodPrecision.current,
    previous: coverage.periodPrecision.previous,
  };

  return {
    schemaVersion: 1,
    revision: input.revision,
    generatedAt: input.now,
    timeZone,
    filters,
    precision: coverage.precision,
    periodPrecision,
    coverage: {
      complete: coverage.complete,
      residual: coverage.residual,
      pending: coverage.pending,
      failed: coverage.failed,
      mismatch: coverage.mismatch,
      total: coverage.total,
    },
    summary,
    daily,
    previous,
    activity: buildActivity(events, input.now, timeZone, window, {
      tokensByDay,
      averages: { total: summary.tokens, avgPerActiveDay: summary.avgTokensPerActiveDay, avgPerWeek: summary.avgTokensPerWeek },
    }),
    rhythm: buildActivityRhythm(events, window, timeZone),
    efficiency: computeEfficiency(events, sessionRecords, window, timeZone),
    quality: computeQuality(periodEvents),
    burn: computeBurn(events, daily, window, timeZone, { tokens: summary.tokens, cost: summary.cost }),
    counters: buildEventCounters(
      input.counters ?? [],
      new Set(records.map((record) => record.sessionId)),
      filters.scope,
      window,
      timeZone,
    ),
    models: aggregateModels(periodEvents, 'tokens').slice(0, MODELS_LIMIT),
    sessionDonut: buildPrimaryModelSessionDonut(periodEvents, timeZone),
    agents: aggregateAgents(periodEvents),
    topSessions: rankTopSessions(events, records.map((record) => record.session), window, timeZone, TOP_SESSIONS_LIMIT),
    topProjects: rankTopProjects(events, records.map((record) => record.session), window, timeZone, TOP_PROJECTS_LIMIT),
    // Computed from the unscoped input: the picker must list every project.
    projects: listProjects(input.records),
  };
}

export { buildPrimaryModelSessionDonut, eventModelKey, scopeRecords };
