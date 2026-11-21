import type { AnalyticsMetric, ModelAggregate, PeriodBounds, SessionRecord, TopProject, TopSession, UsageEvent } from '../shared/analytics-types';
import { eventTokens } from '../shared/analytics-types';
import { eventModelKey } from './aggregate-core';
import { normalizeDirectory } from './scope';

export const OTHER_MODEL_KEY = '__other__';
export const TOP_SESSIONS_LIMIT = 10;
export const TOP_PROJECTS_LIMIT = 10;

type MutableAggregate = {
  modelKey: string;
  providerID?: string;
  modelID?: string;
  variant?: string;
  tokens: number;
  cost: number;
  reasoningTokens: number;
  steps: number;
  sessions: Set<string>;
};

function metricValue(model: ModelAggregate, metric: AnalyticsMetric): number {
  if (metric === 'cost') {
    return model.cost;
  }

  if (metric === 'sessions') {
    return model.sessions;
  }

  if (metric === 'steps') {
    return model.steps;
  }

  return model.tokens;
}

/**
 * Per-model aggregates for the event set. `sessions` counts distinct sessions
 * containing the model and may overlap across models; variants rank as
 * separate rows. The list is ranked by the selected metric with stable
 * model-key tie-breaks, so re-ranking for a different metric keeps each row's
 * identity intact.
 */
export function aggregateModels(events: UsageEvent[], metric: AnalyticsMetric): ModelAggregate[] {
  const buckets = new Map<string, MutableAggregate>();

  for (const event of events) {
    const modelKey = eventModelKey(event);
    const bucket = buckets.get(modelKey) ?? {
      modelKey,
      providerID: event.providerID,
      modelID: event.modelID,
      variant: event.variant,
      tokens: 0,
      cost: 0,
      reasoningTokens: 0,
      steps: 0,
      sessions: new Set<string>(),
    };

    bucket.tokens += eventTokens(event);
    bucket.cost += event.cost;
    bucket.reasoningTokens += event.tokens.reasoning;
    bucket.steps += event.messageCount;
    bucket.sessions.add(event.sessionId);

    if (bucket.providerID === undefined) {
      bucket.providerID = event.providerID;
    }

    if (bucket.modelID === undefined) {
      bucket.modelID = event.modelID;
    }

    if (bucket.variant === undefined) {
      bucket.variant = event.variant;
    }

    buckets.set(modelKey, bucket);
  }

  const totalTokens = [...buckets.values()].reduce((acc, bucket) => acc + bucket.tokens, 0);
  const models = [...buckets.values()].map((bucket) => ({
    modelKey: bucket.modelKey,
    providerID: bucket.providerID,
    modelID: bucket.modelID,
    variant: bucket.variant,
    tokens: bucket.tokens,
    cost: bucket.cost,
    reasoningTokens: bucket.reasoningTokens,
    steps: bucket.steps,
    sessions: bucket.sessions.size,
    share: totalTokens === 0 ? undefined : bucket.tokens / totalTokens,
  }));

  return models.sort(
    (a, b) =>
      metricValue(b, metric) - metricValue(a, metric) ||
      a.modelKey.localeCompare(b.modelKey),
  );
}

/**
 * Leaderboard rows: the top `limit` models by the selected metric plus one
 * Other aggregate carrying the remaining totals. Source identity is preserved
 * through the sort — rows keep their own model keys and values.
 */
export function topModelsWithOther(
  models: ModelAggregate[],
  metric: AnalyticsMetric,
  limit = 5,
  events?: readonly UsageEvent[],
): ModelAggregate[] {
  if (models.length <= limit) {
    return models;
  }

  const top = models.slice(0, limit);
  const rest = models.slice(limit);

  // Per-model session counts overlap, so summing them overcounts. With the
  // source events the Other row counts distinct sessions; without them it
  // falls back to the largest single model (a lower bound).
  let otherSessions: number;

  if (events) {
    const restKeys = new Set(rest.map((model) => model.modelKey));
    const sessionIds = new Set<string>();

    for (const event of events) {
      if (restKeys.has(eventModelKey(event))) {
        sessionIds.add(event.sessionId);
      }
    }

    otherSessions = sessionIds.size;
  } else {
    otherSessions = rest.reduce((acc, model) => Math.max(acc, model.sessions), 0);
  }

  const other: ModelAggregate = {
    modelKey: OTHER_MODEL_KEY,
    tokens: rest.reduce((acc, model) => acc + model.tokens, 0),
    cost: rest.reduce((acc, model) => acc + model.cost, 0),
    reasoningTokens: rest.reduce((acc, model) => acc + model.reasoningTokens, 0),
    steps: rest.reduce((acc, model) => acc + model.steps, 0),
    sessions: otherSessions,
  };

  return [...top, other];
}

/**
 * Sessions-per-model donut: each session with usage events in the set is
 * assigned to exactly one primary model — the model with the greatest session
 * tokens, tie-broken by cost then stable model key — so slices never exceed
 * the total distinct session count.
 */
export function buildPrimaryModelSessionDonut(
  events: UsageEvent[],
  _timeZone: string,
): ModelAggregate[] {
  type SessionModel = { key: string; tokens: number; cost: number; reasoning: number; steps: number };
  const sessionModels = new Map<string, Map<string, SessionModel>>();

  for (const event of events) {
    const list = sessionModels.get(event.sessionId) ?? new Map<string, SessionModel>();
    const modelKey = eventModelKey(event);
    const existing = list.get(modelKey);
    const eventTotal = eventTokens(event);

    if (existing) {
      existing.tokens += eventTotal;
      existing.cost += event.cost;
      existing.reasoning += event.tokens.reasoning;
      existing.steps += event.messageCount;
    } else {
      list.set(modelKey, { key: modelKey, tokens: eventTotal, cost: event.cost, reasoning: event.tokens.reasoning, steps: event.messageCount });
    }

    sessionModels.set(event.sessionId, list);
  }

  const primary = new Map<string, { tokens: number; cost: number; sessions: number; reasoningTokens: number; steps: number }>();

  for (const [, models] of sessionModels) {
    const best = [...models.values()].sort(
      (a, b) =>
        b.tokens - a.tokens ||
        b.cost - a.cost ||
        a.key.localeCompare(b.key),
    )[0];

    if (!best) {
      continue;
    }

    const entry = primary.get(best.key) ?? { tokens: 0, cost: 0, sessions: 0, reasoningTokens: 0, steps: 0 };
    entry.sessions += 1;
    entry.tokens += best.tokens;
    entry.cost += best.cost;
    entry.reasoningTokens += best.reasoning;
    entry.steps += best.steps;
    primary.set(best.key, entry);
  }

  const totalSessions = sessionModels.size;

  return [...primary.entries()]
    .map(([modelKey, entry]) => ({
      modelKey,
      tokens: entry.tokens,
      cost: entry.cost,
      reasoningTokens: entry.reasoningTokens,
      steps: entry.steps,
      sessions: entry.sessions,
      share: totalSessions === 0 ? undefined : entry.sessions / totalSessions,
    }))
    .sort((a, b) => b.sessions - a.sessions || a.modelKey.localeCompare(b.modelKey));
}

/** Final non-empty directory segment, falling back to the full directory. */
export function projectLabel(directory: string): string {
  if (directory === '') {
    return '';
  }

  const segments = directory.split(/[\\/]/).filter((segment) => segment !== '');
  const last = segments.at(-1);
  return last ?? directory;
}

/**
 * Top Sessions for the period: sessions with at least one usage event in the
 * window, ranked by cost descending with a token tie-break, capped at `limit`.
 */
export function rankTopSessions(
  events: UsageEvent[],
  sessions: readonly SessionRecord[],
  window: PeriodBounds,
  _timeZone: string,
  limit = TOP_SESSIONS_LIMIT,
): TopSession[] {
  const byId = new Map(sessions.map((session) => [session.sessionId, session]));
  const totals = new Map<string, { tokens: number; cost: number; lastActivity: number }>();

  for (const event of events) {
    if (event.timestamp < window.startMs || event.timestamp > window.endMs) {
      continue;
    }

    const entry = totals.get(event.sessionId) ?? { tokens: 0, cost: 0, lastActivity: 0 };
    entry.tokens += eventTokens(event);
    entry.cost += event.cost;
    entry.lastActivity = Math.max(entry.lastActivity, event.timestamp);
    totals.set(event.sessionId, entry);
  }

  return [...totals.entries()]
    .map(([sessionId, entry]) => {
      const session = byId.get(sessionId);

      return {
        sessionId,
        title: session?.title ?? 'Untitled session',
        projectLabel: projectLabel(session?.directory ?? ''),
        directory: session?.directory ?? '',
        tokens: entry.tokens,
        cost: entry.cost,
        lastActivity: entry.lastActivity,
      };
    })
    .sort((a, b) => b.cost - a.cost || b.tokens - a.tokens || a.sessionId.localeCompare(b.sessionId))
    .slice(0, limit);
}

/**
 * Projects ranked by cost then tokens over the period window. Grouping uses
 * the canonical session directory, so equal basenames remain distinct and
 * path spelling cannot split one project. Unknown-session events use the bare
 * root project like Top Sessions does.
 */
export function rankTopProjects(
  events: UsageEvent[],
  sessions: readonly SessionRecord[],
  window: PeriodBounds,
  _timeZone: string,
  limit = TOP_PROJECTS_LIMIT,
): TopProject[] {
  const byId = new Map(sessions.map((session) => [session.sessionId, session]));
  const totals = new Map<string, { directory: string; tokens: number; cost: number; lastActivity: number; sessions: Set<string> }>();

  for (const event of events) {
    if (event.timestamp < window.startMs || event.timestamp > window.endMs) {
      continue;
    }

    const rawDirectory = byId.get(event.sessionId)?.directory ?? '';
    const directory = rawDirectory === '' ? '' : normalizeDirectory(rawDirectory);
    const entry = totals.get(directory) ?? { directory, tokens: 0, cost: 0, lastActivity: 0, sessions: new Set<string>() };
    entry.tokens += eventTokens(event);
    entry.cost += event.cost;
    entry.lastActivity = Math.max(entry.lastActivity, event.timestamp);
    entry.sessions.add(event.sessionId);
    totals.set(directory, entry);
  }

  return [...totals.entries()]
    .map(([directory, entry]) => ({
      label: projectLabel(directory),
      directory,
      tokens: entry.tokens,
      cost: entry.cost,
      lastActivity: entry.lastActivity,
      sessions: entry.sessions.size,
    }))
    .sort((a, b) => b.cost - a.cost || b.tokens - a.tokens || a.label.localeCompare(b.label))
    .slice(0, limit);
}
