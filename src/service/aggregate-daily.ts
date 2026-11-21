import type {
  BreakdownSeries,
  DailyBucket,
  EfficiencyViewModel,
  PeriodBounds,
  PromptCachingSeries,
  SessionRecord,
  UsageEvent,
} from '../shared/analytics-types';
import { eventModelKey } from './aggregate-core';
import { listLocalDayKeys, localDayKey } from './time';

function inWindow(event: UsageEvent, window: PeriodBounds): boolean {
  return event.timestamp >= window.startMs && event.timestamp <= window.endMs;
}

/**
 * One bucket per local calendar day from the range start through today,
 * including zero days. Usage events allocate by their own message timestamps;
 * provisional snapshot events naturally land at the session update time until
 * detailed data replaces them.
 */
export function buildDailyBuckets(
  events: UsageEvent[],
  window: PeriodBounds,
  timeZone: string,
): DailyBucket[] {
  const keys = listLocalDayKeys(window.startDay, window.endDay, timeZone);
  const index = new Map<string, {
    tokens: number;
    cost: number;
    steps: number;
    sessions: Set<string>;
    breakdown: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number };
    models: Map<string, { tokens: number; cost: number }>;
  }>();

  for (const day of keys) {
    index.set(day, {
      tokens: 0,
      cost: 0,
      steps: 0,
      sessions: new Set<string>(),
      breakdown: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      models: new Map<string, { tokens: number; cost: number }>(),
    });
  }

  for (const event of events) {
    if (!inWindow(event, window)) {
      continue;
    }

    const day = localDayKey(event.timestamp, timeZone);
    const bucket = index.get(day);

    if (!bucket) {
      continue;
    }

    const eventTotal = event.tokens.input + event.tokens.output + event.tokens.reasoning + event.tokens.cache.read + event.tokens.cache.write;

    bucket.tokens += eventTotal;
    bucket.cost += event.cost;
    bucket.steps += event.messageCount;
    bucket.sessions.add(event.sessionId);
    bucket.breakdown.input += event.tokens.input;
    bucket.breakdown.output += event.tokens.output;
    bucket.breakdown.reasoning += event.tokens.reasoning;
    bucket.breakdown.cacheRead += event.tokens.cache.read;
    bucket.breakdown.cacheWrite += event.tokens.cache.write;

    const modelKey = eventModelKey(event);
    const model = bucket.models.get(modelKey) ?? { tokens: 0, cost: 0 };
    model.tokens += eventTotal;
    model.cost += event.cost;
    bucket.models.set(modelKey, model);
  }

  return keys.map((day) => {
    const bucket = index.get(day)!;

    return {
      day,
      tokens: bucket.tokens,
      cost: bucket.cost,
      steps: bucket.steps,
      sessions: bucket.sessions.size,
      breakdown: bucket.breakdown,
      models: [...bucket.models.entries()]
        .map(([modelKey, value]) => ({ modelKey, ...value }))
        .sort((a, b) => b.tokens - a.tokens || a.modelKey.localeCompare(b.modelKey)),
    };
  });
}

const BREAKDOWN_LABELS: { key: BreakdownSeries['key']; label: string }[] = [
  { key: 'input', label: 'Input' },
  { key: 'output', label: 'Output' },
  { key: 'reasoning', label: 'Reasoning' },
  { key: 'cacheRead', label: 'Cache read' },
  { key: 'cacheWrite', label: 'Cache write' },
];

/** All five token components as stacked series; totals reconcile with tokens. */
export function buildTokenBreakdown(buckets: DailyBucket[]): BreakdownSeries[] {
  return BREAKDOWN_LABELS.map(({ key, label }) => ({
    key,
    label,
    points: buckets.map((bucket) => ({ day: bucket.day, value: bucket.breakdown[key] })),
  }));
}

/**
 * Prompt caching: uncached input and cache read. Cache read is not subtracted
 * from input, matching the cache-hit denominator `input + cache.read`.
 */
export function buildPromptCaching(buckets: DailyBucket[]): PromptCachingSeries[] {
  return [
    {
      key: 'uncachedInput',
      label: 'Uncached input',
      points: buckets.map((bucket) => ({ day: bucket.day, value: bucket.breakdown.input })),
    },
    {
      key: 'cacheRead',
      label: 'Cache read',
      points: buckets.map((bucket) => ({ day: bucket.day, value: bucket.breakdown.cacheRead })),
    },
  ];
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? 0;
  }

  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/**
 * Efficiency metrics for the period: cost/token/session rates from the
 * windowed event set, plus wall-clock session spans (`updated - created`,
 * which can include idle time) for sessions with at least one event in the
 * window. Zero, negative, and non-finite spans are excluded. Busy time and
 * outcome come from the runtime's session metadata; sessions synced before
 * those fields existed report no outcome until their next change or a Reset.
 */
export function computeEfficiency(
  events: UsageEvent[],
  sessions: readonly SessionRecord[],
  window: PeriodBounds,
  _timeZone: string,
): EfficiencyViewModel {
  const periodEvents = events.filter((event) => inWindow(event, window));

  let tokens = 0;
  let cost = 0;
  let prompts = 0;
  let reasoning = 0;
  const sessionIds = new Set<string>();

  for (const event of periodEvents) {
    tokens += event.tokens.input + event.tokens.output + event.tokens.reasoning + event.tokens.cache.read + event.tokens.cache.write;
    cost += event.cost;
    prompts += event.messageCount;
    reasoning += event.tokens.reasoning;
    sessionIds.add(event.sessionId);
  }

  const sessionCount = sessionIds.size;
  const byId = new Map(sessions.map((session) => [session.sessionId, session]));
  const spans: number[] = [];

  for (const sessionId of sessionIds) {
    const session = byId.get(sessionId);

    if (!session) {
      continue;
    }

    const span = session.timeUpdated - session.timeCreated;

    if (Number.isFinite(span) && span > 0) {
      spans.push(span);
    }
  }

  const spanSum = spans.reduce((acc, span) => acc + span, 0);
  let failed = 0;
  let interrupted = 0;
  let withOutcome = 0;

  for (const sessionId of sessionIds) {
    const session = byId.get(sessionId);

    if (!session) {
      continue;
    }

    if (session.outcome !== undefined) {
      withOutcome += 1;

      if (session.outcome === 'failed') {
        failed += 1;
      } else if (session.outcome === 'interrupted') {
        interrupted += 1;
      }
    }
  }

  return {
    costPerMillion: tokens === 0 ? 0 : (cost / tokens) * 1_000_000,
    costPerSession: sessionCount === 0 ? 0 : cost / sessionCount,
    tokensPerSession: sessionCount === 0 ? 0 : tokens / sessionCount,
    stepsPerSession: sessionCount === 0 ? 0 : prompts / sessionCount,
    reasoningShare: tokens === 0 ? 0 : reasoning / tokens,
    avgSessionSpan: spans.length === 0 ? 0 : spanSum / spans.length,
    medianSessionSpan: median(spans),
    longestSessionSpan: spans.length === 0 ? 0 : Math.max(...spans),
    failedSessions: failed,
    interruptedSessions: interrupted,
    sessionsWithOutcome: withOutcome,
    failedSessionRate: withOutcome === 0 ? 0 : failed / withOutcome,
  };
}
