import { describe, expect, it } from 'vitest';

import { buildAnalyticsSnapshot, snapshotCacheKey } from '../../src/service/snapshot';
import type { AnalyticsFilters, StoredSessionAnalytics, UsageEvent } from '../../src/shared/analytics-types';

const TZ = 'UTC';
const NOW = Date.parse('2026-11-18T12:00:00Z');
const DAY_MS = 86_400_000;

const FILTERS: AnalyticsFilters = {
  scope: 'all',
  range: '30d',
  surface: 'page',
  timeZone: TZ,
};

function makeEvent(sessionId: string, overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    sessionId,
    timestamp: NOW - DAY_MS,
    providerID: 'zai',
    modelID: 'glm-5',
    tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 1 } },
    cost: 0.5,
    messageCount: 1,
    source: 'assistant',
    estimated: false,
    ...overrides,
  };
}

function makeRecord(sessionId: string, events: UsageEvent[]): StoredSessionAnalytics {
  return {
    sessionId,
    session: {
      sessionId,
      title: `Session ${sessionId}`,
      directory: '/repo/demo',
      timeCreated: NOW - 2 * DAY_MS,
      timeUpdated: NOW - DAY_MS,
      tokens: null,
      cost: null,
    },
    fingerprint: 'fp',
    state: 'complete',
    attempts: 1,
    syncedAt: NOW,
    events,
  };
}

describe('buildAnalyticsSnapshot', () => {
  const events = [
    makeEvent('ses_1'),
    makeEvent('ses_1', { modelID: 'glm-6', timestamp: NOW - 2 * DAY_MS }),
    makeEvent('ses_2', { timestamp: NOW - 3 * DAY_MS, cost: 0.25 }),
  ];
  const records = [makeRecord('ses_1', events.filter((event) => event.sessionId === 'ses_1')), makeRecord('ses_2', events.filter((event) => event.sessionId === 'ses_2'))];

  const snapshot = buildAnalyticsSnapshot({
    filters: FILTERS,
    revision: 7,
    now: NOW,
    records,
  });

  it('echoes filters, effective timezone, revision, and schema version', () => {
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.revision).toBe(7);
    expect(snapshot.generatedAt).toBe(NOW);
    expect(snapshot.timeZone).toBe(TZ);
    expect(snapshot.filters.range).toBe('30d');
    expect(snapshot.filters.scope).toBe('all');
  });

  it('keeps page and panel KPIs consistent from the same records', () => {
    const panel = buildAnalyticsSnapshot({
      filters: { ...FILTERS, surface: 'panel' },
      revision: 7,
      now: NOW,
      records,
    });

    expect(panel.summary.tokens).toBe(snapshot.summary.tokens);
    expect(panel.summary.cost).toBeCloseTo(snapshot.summary.cost, 9);
    expect(panel.summary.sessions).toBe(snapshot.summary.sessions);
    expect(panel.summary.activeDays).toBe(snapshot.summary.activeDays);
    expect(panel.coverage.total).toBe(snapshot.coverage.total);
  });

  it('reconciles daily and model sums with the summary totals', () => {
    const dailySum = snapshot.daily.reduce((acc, bucket) => acc + bucket.tokens, 0);
    expect(dailySum).toBe(snapshot.summary.tokens);

    const modelSum = snapshot.models.reduce((acc, model) => acc + model.tokens, 0);
    expect(modelSum).toBe(snapshot.summary.tokens);

    const breakdownSum = snapshot.daily.reduce(
      (acc, bucket) =>
        acc + bucket.breakdown.input + bucket.breakdown.output + bucket.breakdown.reasoning + bucket.breakdown.cacheRead + bucket.breakdown.cacheWrite,
      0,
    );
    expect(breakdownSum).toBe(snapshot.summary.tokens);
  });

  it('includes previous-period data only for 7/30/90-day ranges', () => {
    expect(snapshot.previous).toBeDefined();

    const allTime = buildAnalyticsSnapshot({
      filters: { ...FILTERS, range: 'all' },
      revision: 7,
      now: NOW,
      records,
    });

    expect(allTime.previous).toBeUndefined();
    expect(allTime.periodPrecision.previous).toBeUndefined();
    // The year grid stays yearly-sized even for All time (spec: ~12 months).
    expect(allTime.activity.cells.length).toBeGreaterThan(350);
    expect(allTime.activity.cells.length).toBeLessThan(380);
  });

  it('caps embedded Top Sessions and model/agent lists', () => {
    const manySessions = Array.from({ length: 14 }, (_, index) => {
      const sessionId = `ses_cap_${index}`;
      return makeRecord(sessionId, [makeEvent(sessionId, { cost: 0.01 * (index + 1) })]);
    });

    const capped = buildAnalyticsSnapshot({
      filters: FILTERS,
      revision: 7,
      now: NOW,
      records: manySessions,
    });

    expect(capped.topSessions).toHaveLength(10);

    const manyModels = Array.from({ length: 520 }, (_, index) => {
      const sessionId = `ses_model_${index}`;
      return makeRecord(sessionId, [makeEvent(sessionId, { modelID: `model-${index}`, cost: 0.001 })]);
    });

    const modelCapped = buildAnalyticsSnapshot({
      filters: FILTERS,
      revision: 7,
      now: NOW,
      records: manyModels,
    });

    expect(modelCapped.models.length).toBeLessThanOrEqual(512);
  });

  it('applies project scope with strict directory equality', () => {
    const other = makeRecord('ses_other', [makeEvent('ses_other', { timestamp: NOW - DAY_MS })]);
    other.session.directory = '/repo/other';

    const scoped = buildAnalyticsSnapshot({
      filters: { ...FILTERS, scope: 'project', directory: '/repo/demo' },
      revision: 7,
      now: NOW,
      records: [...records, other],
    });

    expect(scoped.summary.sessions).toBe(2);
    expect(scoped.topSessions.every((session) => session.sessionId !== 'ses_other')).toBe(true);
  });

  it('lists every project from all records regardless of the active filters', () => {
    const other = makeRecord('ses_other', [makeEvent('ses_other', { timestamp: NOW - DAY_MS })]);
    other.session.directory = '/repo/other';

    const scoped = buildAnalyticsSnapshot({
      filters: { ...FILTERS, scope: 'project', directory: '/repo/demo' },
      revision: 7,
      now: NOW,
      records: [...records, other],
    });

    expect(scoped.projects?.map((project) => project.directory)).toEqual(['/repo/demo', '/repo/other']);
    expect(scoped.projects?.[0]).toEqual({ directory: '/repo/demo', label: 'demo', sessions: 2, tokens: 63, cost: 1.25 });
  });

  it('exposes activity, rhythm, efficiency, and agents', () => {
    expect(snapshot.activity.cells.length).toBeGreaterThan(350);
    expect(snapshot.rhythm).toHaveLength(7 * 24);
    expect(snapshot.efficiency.tokensPerSession).toBeGreaterThan(0);
    expect(snapshot.agents.length).toBeGreaterThan(0);
  });
});

describe('snapshotCacheKey', () => {
  it('separates cached snapshots by scope, directory, range, surface, and timezone', () => {
    const base = snapshotCacheKey(FILTERS);

    expect(base).toBe(snapshotCacheKey({ ...FILTERS }));

    expect(snapshotCacheKey({ ...FILTERS, range: '7d' })).not.toBe(base);
    expect(snapshotCacheKey({ ...FILTERS, surface: 'panel' })).not.toBe(base);
    expect(snapshotCacheKey({ ...FILTERS, scope: 'project', directory: '/repo/demo' })).not.toBe(base);
    // A different viewer timezone must never share a cache key.
    expect(snapshotCacheKey({ ...FILTERS, timeZone: 'Pacific/Kiritimati' })).not.toBe(base);
  });

  it('changes across the viewer local midnight so cached snapshots never go stale', () => {
    const before = Date.parse('2026-11-18T23:30:00Z');
    const after = Date.parse('2026-11-19T00:30:00Z');

    expect(snapshotCacheKey(FILTERS, before)).toBe(snapshotCacheKey(FILTERS, before + 1000));
    expect(snapshotCacheKey(FILTERS, before)).not.toBe(snapshotCacheKey(FILTERS, after));
  });
});
