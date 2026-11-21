// @vitest-environment jsdom
import type { AnalyticsSnapshot, ModelAggregate, TopSession, UsageEvent } from '../../src/shared/analytics-types';
import type { HostBridge } from '../../src/shared/host';

const NOW = Date.parse('2026-11-18T12:00:00Z');
const DAY_MS = 86_400_000;

export const NOW_TS = NOW;

function dailyBuckets(count: number): AnalyticsSnapshot['daily'] {
  const buckets: AnalyticsSnapshot['daily'] = [];

  for (let index = 0; index < count; index += 1) {
    const day = new Date(NOW - (count - 1 - index) * DAY_MS).toISOString().slice(0, 10);

    buckets.push({
      day,
      tokens: 100 + index * 10,
      cost: 0.5 + index * 0.01,
      sessions: 1 + (index % 3),
      steps: 3 + (index % 4),
      breakdown: {
        input: 50 + index,
        output: 30 + index,
        reasoning: 10 + index,
        cacheRead: 5 + index,
        cacheWrite: 5 + index,
      },
      models: [
        { modelKey: 'zai/glm-5', tokens: 60 + index, cost: 0.3 },
        { modelKey: 'zai/glm-6', tokens: 40 + index, cost: 0.2 },
      ],
    });
  }

  return buckets;
}

function modelAggregates(): ModelAggregate[] {
  return [
    { modelKey: 'zai/glm-5', providerID: 'zai', modelID: 'glm-5', variant: 'max', tokens: 5000, cost: 3.2, reasoningTokens: 400, steps: 120, sessions: 12, share: 0.5 },
    { modelKey: 'zai/glm-6', providerID: 'zai', modelID: 'glm-6', variant: 'default', tokens: 2400, cost: 1.4, reasoningTokens: 200, steps: 60, sessions: 8, share: 0.24 },
    { modelKey: 'openai/o3', providerID: 'openai', modelID: 'o3', tokens: 1200, cost: 2.4, reasoningTokens: 600, steps: 30, sessions: 4, share: 0.12 },
    { modelKey: 'anthropic/claude-4', providerID: 'anthropic', modelID: 'claude-4', tokens: 900, cost: 0.9, reasoningTokens: 300, steps: 25, sessions: 3, share: 0.09 },
    { modelKey: 'google/gemini-3', providerID: 'google', modelID: 'gemini-3', tokens: 400, cost: 0.3, reasoningTokens: 50, steps: 10, sessions: 2, share: 0.04 },
    { modelKey: 'zai/glm-4', providerID: 'zai', modelID: 'glm-4', tokens: 100, cost: 0.1, reasoningTokens: 10, steps: 5, sessions: 1, share: 0.01 },
  ];
}

function topSessions(count: number): TopSession[] {
  const sessions: TopSession[] = [];

  for (let index = 0; index < count; index += 1) {
    sessions.push({
      sessionId: `ses_${String(index).padStart(2, '0')}`,
      title: `Very long session title number ${index} that should truncate gracefully`,
      projectLabel: 'demo',
      directory: '/repo/demo',
      tokens: 5000 - index * 100,
      cost: 2.5 - index * 0.1,
      lastActivity: NOW - index * DAY_MS,
    });
  }

  return sessions;
}

export function buildSnapshot(overrides: Partial<AnalyticsSnapshot> = {}): AnalyticsSnapshot {
  const activityCells: AnalyticsSnapshot['activity']['cells'] = [];

  for (let index = 0; index < 21; index += 1) {
    const value = index === 9 ? 90 : index % 3 === 0 ? 25 : 0;
    const level = value === 0 ? 0 : value >= 90 ? 4 : value >= 25 ? 2 : 1;
    const day = new Date(NOW - (20 - index) * DAY_MS).toISOString().slice(0, 10);

    activityCells.push({
      day,
      tokens: value,
      level: level as 0 | 1 | 2 | 3 | 4,
      label: `${day}: ${value} tokens`,
    });
  }

  const rhythm: AnalyticsSnapshot['rhythm'] = [];

  for (let weekday = 0; weekday < 7; weekday += 1) {
    for (let hour = 0; hour < 24; hour += 1) {
      const tokens = weekday === 2 && hour === 10 ? 500 : 0;
      rhythm.push({
        weekday,
        hour,
        tokens,
        level: (tokens > 0 ? 4 : 0) as 0 | 4,
        label: `${tokens} tokens`,
      });
    }
  }

  const summary: AnalyticsSnapshot['summary'] = {
    tokens: 10000,
    cost: 8.3,
    sessions: 30,
    subagents: 9,
    prompts: 250,
    activeDays: 18,
    avgTokensPerActiveDay: 555,
    avgTokensPerWeek: 2333,
    currentStreak: 4,
    inputTokens: 5200,
    outputTokens: 2600,
    reasoningTokens: 1560,
    cacheReadTokens: 520,
    cacheWriteTokens: 120,
    cacheHitRate: 0.09,
    reasoningShare: 0.156,
    costPerMillion: 830,
    costPerSession: 0.27,
    tokensPerSession: 333,
  };

  return {
    schemaVersion: 1,
    revision: 1,
    generatedAt: NOW,
    timeZone: 'UTC',
    filters: { scope: 'all', range: '30d', surface: 'page', timeZone: 'UTC' },
    precision: 'exact',
    periodPrecision: { current: 'exact', previous: 'exact' },
    coverage: { complete: 30, residual: 0, pending: 0, failed: 0, mismatch: 0, total: 30 },
    summary,
    daily: dailyBuckets(40),
    previous: { ...summary, tokens: 8000, cost: 7.0, sessions: 25 },
    activity: {
      cells: activityCells,
      longestStreak: 5,
      avgTokensPerActiveDay: 555,
      avgTokensPerWeek: 2333,
      totalTokens: 10000,
    },
    rhythm,
    efficiency: {
      costPerMillion: 830,
      costPerSession: 0.27,
      tokensPerSession: 333,
      stepsPerSession: 8.3,
      reasoningShare: 0.156,
      avgSessionSpan: 45 * 60_000,
      medianSessionSpan: 30 * 60_000,
      longestSessionSpan: 4 * 3_600_000,
      failedSessionRate: 0,
      failedSessions: 0,
      interruptedSessions: 0,
      sessionsWithOutcome: 0,
    },
    models: modelAggregates(),
    sessionDonut: [
      { modelKey: 'zai/glm-5', providerID: 'zai', modelID: 'glm-5', tokens: 6000, cost: 4.0, reasoningTokens: 500, steps: 140, sessions: 18, share: 0.6 },
      { modelKey: 'zai/glm-6', providerID: 'zai', modelID: 'glm-6', tokens: 3000, cost: 2.0, reasoningTokens: 250, steps: 70, sessions: 9, share: 0.3 },
      { modelKey: 'openai/o3', providerID: 'openai', modelID: 'o3', tokens: 1000, cost: 2.3, reasoningTokens: 500, steps: 40, sessions: 3, share: 0.1 },
    ],
    agents: [
      { agent: 'build', tokens: 8000, cost: 6.5, sessions: 22 },
      { agent: 'plan', tokens: 2000, cost: 1.8, sessions: 8 },
    ],
    topSessions: topSessions(12),
    topProjects: [
      { label: 'demo', directory: '/repo/demo', tokens: 8000, cost: 6.1, lastActivity: NOW, sessions: 22 },
      { label: 'other-repo', directory: '/repo/other-repo', tokens: 1500, cost: 1.7, lastActivity: NOW - DAY_MS, sessions: 6 },
      { label: 'third', directory: '/repo/third', tokens: 500, cost: 0.5, lastActivity: NOW - 2 * DAY_MS, sessions: 2 },
    ],
    ...overrides,
  };
}

export type BridgeMode = 'ok' | 'failure' | 'empty';

export type PageHarness = {
  container: HTMLElement;
  bridge: HostBridge & {
    serviceListeners: Set<(event: { topic: string; data: unknown }) => void>;
    setMode(mode: BridgeMode): void;
    openCalls: string[];
    openFailures: boolean;
    watchCalls: { origin: string; sessionId: string | null }[];
    setRateFixture(fixture: Record<string, unknown> | null): void;
    /** Snapshot GETs seen by the fake service, newest last. */
    snapshotRequests: { scope: string; directory?: string; range: string }[];
    /** Everything the surface persisted, keyed by storage key. */
    storageSets: Record<string, unknown>;
    readyListeners: Set<(ctx: never) => void>;
    directoryListeners: Set<(directory: string | null) => void>;
  };
  events: { topic: string; data: unknown }[];
};

export async function mountPage(options: { snapshot?: AnalyticsSnapshot; directory?: string | null; storage?: Record<string, unknown>; preferences?: { scope?: 'all' | 'project'; directory?: string } } = {}): Promise<PageHarness> {
  let mode: BridgeMode = options.snapshot === undefined && options.snapshot !== null ? 'empty' : 'ok';
  const current = options.snapshot ?? null;

  const serviceListeners = new Set<(event: { topic: string; data: unknown }) => void>();
  const readyListeners = new Set<(ctx: never) => void>();
  const directoryListeners = new Set<(directory: string | null) => void>();
  const events: { topic: string; data: unknown }[] = [];
  const watchCalls: { origin: string; sessionId: string | null }[] = [];
  const snapshotRequests: { scope: string; directory?: string; range: string }[] = [];
  const storageData = new Map<string, unknown>(Object.entries(options.storage ?? {}));
  const storageSets: Record<string, unknown> = {};
  let rateFixture: Record<string, unknown> | null = null;

  const bridge = {
    serviceListeners,
    openCalls: [] as string[],
    openFailures: false,
    setMode(next: BridgeMode) {
      mode = next;
    },
    onReady: (listener: (ctx: never) => void) => {
      readyListeners.add(listener);
      return () => readyListeners.delete(listener);
    },
    onDirectory: (listener: (directory: string | null) => void) => {
      directoryListeners.add(listener);
      return () => directoryListeners.delete(listener);
    },
    onServiceEvent: (listener: (event: { topic: string; data: unknown }) => void) => {
      serviceListeners.add(listener);
      return () => serviceListeners.delete(listener);
    },
    serviceRequest: async (request: { path?: string; method?: string; body?: string; query?: Record<string, string> }) => {
      if (request.path === '/v1/snapshot') {
        snapshotRequests.push({
          scope: request.query?.scope ?? 'all',
          directory: request.query?.directory,
          range: request.query?.range ?? '30d',
        });
      }

      if (request.path === '/v1/rate') {
        const payload = rateFixture ?? {
          connection: 'live',
          error: null,
          sessionId: 'ses_live',
          busy: false,
          active: false,
          lastEventAt: NOW,
          windowMs: 5000,
          chars: 0,
          charsPerSecond: 0,
          tokensPerSecond: 0,
          charsPerToken: 0.25,
          sessionUsage: null,
          lastTurn: null,
          eventsSeen: 0,
          lastEventType: null,
          waiting: null,
        };
        return { status: 200, body: JSON.stringify(payload) };
      }

      if (request.path === '/v1/watch' && request.method === 'POST') {
        try {
          const parsed = JSON.parse(request.body || '{}') as { origin?: string; sessionId?: string | null };
          watchCalls.push({ origin: parsed.origin ?? '', sessionId: parsed.sessionId ?? null });
          return { status: 200, body: JSON.stringify({ ok: true, changed: true, sessionId: parsed.sessionId ?? null }) };
        } catch {
          return { status: 400, body: '{"error":"bad"}' };
        }
      }

      if (mode === 'failure') {
        return { status: 500, body: '{"error":"down"}' };
      }

      if (mode === 'empty' || current === null) {
        return {
          status: 200,
          body: JSON.stringify(
            buildSnapshot({
              summary: Object.fromEntries(Object.keys(buildSnapshot().summary).map((key) => [key, 0])) as AnalyticsSnapshot['summary'],
              coverage: { complete: 0, residual: 0, pending: 0, failed: 0, mismatch: 0, total: 0 },
              precision: 'exact',
              daily: [],
              models: [],
              agents: [],
              topSessions: [],
              previous: undefined,
              activity: { cells: [], longestStreak: 0, avgTokensPerActiveDay: 0, avgTokensPerWeek: 0, totalTokens: 0 },
              rhythm: [],
            }) as AnalyticsSnapshot,
          ),
        };
      }

      return { status: 200, body: JSON.stringify(current) };
    },
    storage: {
      get: async (key: string) => storageData.get(key),
      set: async (key: string, value: unknown) => {
        storageData.set(key, value);
        storageSets[key] = value;
      },
    },
    openSession: async (sessionId: string) => {
      bridge.openCalls.push(sessionId);

      if (bridge.openFailures) {
        throw new Error('navigation unavailable');
      }
    },
    watchCalls,
    snapshotRequests,
    storageSets,
    readyListeners,
    directoryListeners,
    setRateFixture: (fixture: Record<string, unknown> | null) => {
      rateFixture = fixture;
    },
  } as unknown as PageHarness['bridge'] & {
    readyListeners: Set<(ctx: never) => void>;
    directoryListeners: Set<(directory: string | null) => void>;
  };

  const container = document.createElement('div');
  container.id = 'app';
  document.body.append(container);

  const { createPageController } = await import('../../src/page/controller');
  const controller = createPageController({
    container,
    bridge: bridge as unknown as HostBridge,
    preferences: options.snapshot === undefined
      ? undefined
      : {
          scope: options.preferences?.scope ?? 'all',
          range: '30d',
          metric: 'tokens',
          view: 'daily',
          chart: 'bar',
          directory: options.preferences?.directory,
        },
    timeZone: () => 'UTC',
    eventDebounceMs: 0,
  });

  controller.start();
  await new Promise((resolve) => setTimeout(resolve, 20));

  // Expose context to the page (directory availability).
  for (const listener of readyListeners) {
    listener({ directory: options.directory === null ? null : (options.directory ?? '/repo/demo'), theme: { mode: 'dark', tokens: {} } } as never);
  }
  await new Promise((resolve) => setTimeout(resolve, 10));

  return { container, bridge: bridge as unknown as PageHarness['bridge'], events };
}

export function eventFixture(sessionId: string, overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    sessionId,
    timestamp: NOW,
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    cost: 0.1,
    messageCount: 1,
    source: 'assistant',
    estimated: false,
    ...overrides,
  };
}
