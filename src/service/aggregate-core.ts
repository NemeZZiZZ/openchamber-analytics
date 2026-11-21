import type { PeriodBounds, SessionRecord, SummaryMetrics, UsageEvent } from '../shared/analytics-types';
import { eventTokens } from '../shared/analytics-types';
import { localDayKey, shiftDayKeyBack } from './time';

/**
 * Model identity for an event: `${providerID}/${modelID}` with `unknown` for
 * either unavailable part, suffixed `@variant` when the runtime reports a
 * variant tier — variants rank as separate models. Usage events are never
 * dropped because model metadata is missing.
 */
export function eventModelKey(event: Pick<UsageEvent, 'providerID' | 'modelID' | 'variant'>): string {
  const base = `${event.providerID ?? 'unknown'}/${event.modelID ?? 'unknown'}`;
  return event.variant ? `${base}@${event.variant}` : base;
}

function inWindow(event: UsageEvent, window: PeriodBounds): boolean {
  return event.timestamp >= window.startMs && event.timestamp <= window.endMs;
}

/**
 * Current-day streak over the passed events' local activity days: start at
 * today; when today is inactive, start yesterday; count consecutive active
 * local days backward. Computed over all passed events rather than only the
 * window slice so a streak older than the selected range still renders.
 */
function currentStreak(activeDays: { has(day: string): boolean }, endDay: string): number {
  let day = activeDays.has(endDay) ? endDay : shiftDayKeyBack(endDay, 1);

  if (!activeDays.has(day)) {
    return 0;
  }

  let streak = 0;

  while (activeDays.has(day)) {
    streak += 1;
    day = shiftDayKeyBack(day, 1);
  }

  return streak;
}

/**
 * Core period metrics over the selected project/period event set. Events
 * outside `[window.startMs, window.endMs]` are excluded from period metrics;
 * the current streak uses the complete passed event set. When session records
 * are provided, `subagents` counts distinct in-period sessions that have a
 * parent session.
 */
export function aggregateSummary(
  events: UsageEvent[],
  window: PeriodBounds,
  timeZone: string,
  sessions?: readonly SessionRecord[],
  options: {
    streak?: boolean;
    /** Precomputed tokens per local day over all events (avoids a second pass). */
    tokensByDay?: ReadonlyMap<string, number>;
  } = {},
): SummaryMetrics {
  const periodEvents = events.filter((event) => inWindow(event, window));

  let tokens = 0;
  let cost = 0;
  let prompts = 0;
  let input = 0;
  let output = 0;
  let reasoning = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  const sessionIds = new Set<string>();
  const activeDays = new Set<string>();

  for (const event of periodEvents) {
    tokens += eventTokens(event);
    cost += event.cost;
    prompts += event.messageCount;
    input += event.tokens.input;
    output += event.tokens.output;
    reasoning += event.tokens.reasoning;
    cacheRead += event.tokens.cache.read;
    cacheWrite += event.tokens.cache.write;
    sessionIds.add(event.sessionId);
    activeDays.add(localDayKey(event.timestamp, timeZone));
  }

  const sessionsById = new Map((sessions ?? []).map((session) => [session.sessionId, session]));
  const subagents = new Set(
    [...sessionIds].filter((sessionId) => sessionsById.get(sessionId)?.parentSessionId !== undefined),
  ).size;

  const sessionCount = sessionIds.size;
  const activeDayCount = activeDays.size;
  const weeks = Math.max(1, Math.ceil(window.dayCount / 7));
  const hitDenominator = input + cacheRead;

  return {
    tokens,
    cost,
    sessions: sessionCount,
    subagents,
    prompts,
    activeDays: activeDayCount,
    avgTokensPerActiveDay: activeDayCount === 0 ? 0 : tokens / activeDayCount,
    avgTokensPerWeek: tokens / weeks,
    currentStreak:
      options.streak === false || events.length === 0
        ? 0
        : currentStreak(options.tokensByDay ?? new Set(events.map((event) => localDayKey(event.timestamp, timeZone))), window.endDay),
    inputTokens: input,
    outputTokens: output,
    reasoningTokens: reasoning,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    cacheHitRate: hitDenominator === 0 ? 0 : cacheRead / hitDenominator,
    reasoningShare: tokens === 0 ? 0 : reasoning / tokens,
    costPerMillion: tokens === 0 ? 0 : (cost / tokens) * 1_000_000,
    costPerSession: sessionCount === 0 ? 0 : cost / sessionCount,
    tokensPerSession: sessionCount === 0 ? 0 : tokens / sessionCount,
  };
}
