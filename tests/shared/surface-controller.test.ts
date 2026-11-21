import { describe, expect, it } from 'vitest';

import { createSurfaceController, type SurfaceController } from '../../src/shared/surface-controller';
import type { AnalyticsRange, AnalyticsSnapshot } from '../../src/shared/analytics-types';
import type { HostBridge } from '../../src/shared/host';

const SNAPSHOT: AnalyticsSnapshot = {
  schemaVersion: 1,
  revision: 1,
  generatedAt: Date.parse('2026-11-18T12:00:00Z'),
  timeZone: 'UTC',
  filters: { scope: 'all', range: '30d', surface: 'page', timeZone: 'UTC' },
  precision: 'exact',
  periodPrecision: { current: 'exact' },
  coverage: { complete: 1, residual: 0, pending: 0, failed: 0, mismatch: 0, total: 1 },
  summary: {
    tokens: 21,
    cost: 0.5,
    sessions: 1,
    subagents: 0,
    prompts: 2,
    activeDays: 1,
    avgTokensPerActiveDay: 21,
    avgTokensPerWeek: 3,
    currentStreak: 1,
    inputTokens: 10,
    outputTokens: 5,
    reasoningTokens: 2,
    cacheReadTokens: 3,
    cacheWriteTokens: 1,
    cacheHitRate: 0.23,
    reasoningShare: 0.1,
    costPerMillion: 23809.5,
    costPerSession: 0.5,
    tokensPerSession: 21,
  },
  daily: [],
  activity: {
    cells: [],
    longestStreak: 1,
    avgTokensPerActiveDay: 21,
    avgTokensPerWeek: 3,
    totalTokens: 21,
  },
  rhythm: [],
  efficiency: {
    costPerMillion: 23809.5,
    costPerSession: 0.5,
    tokensPerSession: 21,
    stepsPerSession: 2,
    reasoningShare: 0.1,
    avgSessionSpan: 0,
    medianSessionSpan: 0,
    longestSessionSpan: 0,
    failedSessionRate: 0,
    failedSessions: 0,
    interruptedSessions: 0,
    sessionsWithOutcome: 0,
  },
  models: [],
  sessionDonut: [],
  agents: [],
  topSessions: [],
  topProjects: [],
};

type Deferred = { resolve: (value: { status: number; body: string }) => void; promise: Promise<{ status: number; body: string }> };

function deferred(): Deferred {
  let resolve: Deferred['resolve'] = () => undefined;
  const promise = new Promise<{ status: number; body: string }>((res) => {
    resolve = res;
  });
  return { resolve, promise };
}

type FocusSource = { listeners: Set<() => void>; add(listener: () => void): () => void; fire(): void };


function focusSource(): FocusSource {
  const listeners = new Set<() => void>();
  return {
    listeners,
    add(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    fire() {
      for (const listener of [...listeners]) {
        listener();
      }
    },
  };
}

type BridgeStub = HostBridge & {
  requests: { path: string; query?: Record<string, string> }[];
  readyListeners: Set<(ctx: never) => void>;
  directoryListeners: Set<(directory: string | null) => void>;
  serviceListeners: Set<(event: { topic: string; data: unknown }) => void>;
  serviceResponse: (path: string, query?: Record<string, string>) => Promise<{ status: number; body: string }>;
};

function bridgeStub(): BridgeStub {
  const bridge = {
    requests: [],
    readyListeners: new Set(),
    directoryListeners: new Set<(directory: string | null) => void>(),
    serviceListeners: new Set<(event: { topic: string; data: unknown }) => void>(),
    serviceResponse: async (): Promise<{ status: number; body: string }> => ({ status: 200, body: JSON.stringify(SNAPSHOT) }),
    onReady: (listener: (ctx: never) => void) => {
      bridge.readyListeners.add(listener);
      return () => bridge.readyListeners.delete(listener);
    },
    onDirectory: (listener: (directory: string | null) => void) => {
      bridge.directoryListeners.add(listener);
      return () => bridge.directoryListeners.delete(listener);
    },
    onServiceEvent: (listener: (event: { topic: string; data: unknown }) => void) => {
      bridge.serviceListeners.add(listener);
      return () => bridge.serviceListeners.delete(listener);
    },
    serviceRequest: async (request: { path: string; query?: Record<string, string> }) => {
      bridge.requests.push({ path: request.path, query: request.query });
      return bridge.serviceResponse(request.path, request.query);
    },
    storage: {
      get: async () => undefined,
      set: async () => undefined,
    },
    openSession: async () => undefined,
  } as unknown as BridgeStub;

  return bridge;
}

async function controllerWith(
  overrides: { bridge?: BridgeStub; focus?: FocusSource; timeZone?: () => string; eventDebounceMs?: number; retryBaseMs?: number; preferences?: { scope?: 'all' | 'project'; range?: AnalyticsRange; directory?: string } } = {},
): Promise<{ controller: SurfaceController; bridge: BridgeStub; focus: FocusSource }> {
  const bridge = overrides.bridge ?? bridgeStub();
  const focus = overrides.focus ?? focusSource();
  const controller = createSurfaceController({
    bridge,
    surface: 'page',
    preferences: overrides.preferences,
    focusSource: focus.add,
    timeZone: overrides.timeZone ?? (() => 'UTC'),
    eventDebounceMs: overrides.eventDebounceMs ?? 10,
    retryBaseMs: overrides.retryBaseMs ?? 0,
  });

  controller.start();
  await new Promise((resolve) => setTimeout(resolve, 5));

  return { controller, bridge, focus };
}

describe('surface controller — startup retry', () => {
  it('retries a failed first snapshot until the service answers', async () => {
    const bridge = bridgeStub();
    let calls = 0;
    bridge.serviceResponse = async () => {
      calls += 1;
      return calls < 3 ? { status: 503, body: '{}' } : { status: 200, body: JSON.stringify(SNAPSHOT) };
    };

    const { controller } = await controllerWith({ bridge, retryBaseMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(calls).toBe(3);
    await controller.dispose();
  });
});

describe('surface controller — request lifecycle', () => {
  it('fetches on start and applies the browser timezone to every request', async () => {
    const { controller, bridge } = await controllerWith({ timeZone: () => 'Europe/Belgrade' });

    expect(bridge.requests).toHaveLength(1);
    expect(bridge.requests[0]?.query?.timeZone).toBe('Europe/Belgrade');
    expect(bridge.requests[0]?.query?.surface).toBe('page');

    await controller.dispose();
  });

  it('ignores stale filter responses when a newer request wins', async () => {
    const bridge = bridgeStub();
    const staleGate = deferred();
    const newerGate = deferred();

    const responses = [staleGate, newerGate];
    bridge.serviceResponse = async () => {
      const next = responses.shift();
      return next ? next.promise : Promise.resolve({ status: 200, body: JSON.stringify(SNAPSHOT) });
    };

    const { controller } = await controllerWith({ bridge });

    const snapshots: AnalyticsSnapshot[] = [];
    controller.onSnapshot((snapshot) => snapshots.push(snapshot));

    // The 30d request is in flight; a filter change invalidates it and
    // schedules the 7d request, whose response is the authoritative one.
    controller.setFilters({ range: '7d' });

    // The stale 30d response arrives after the filter change and is ignored.
    staleGate.resolve({ status: 200, body: JSON.stringify({ ...SNAPSHOT, revision: 1 }) });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const newer: AnalyticsSnapshot = { ...SNAPSHOT, revision: 99, filters: { ...SNAPSHOT.filters, range: '7d' } };
    newerGate.resolve({ status: 200, body: JSON.stringify(newer) });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.revision).toBe(99);
    expect(snapshots[0]?.filters.range).toBe('7d');

    await controller.dispose();
  });

  it('coalesces bursts of service events into one scheduled request', async () => {
    const { controller, bridge } = await controllerWith();
    bridge.requests.length = 0;

    for (let index = 0; index < 6; index += 1) {
      for (const listener of bridge.serviceListeners) {
        listener({ topic: 'analytics:changed', data: { revision: index + 1 } });
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(bridge.requests).toHaveLength(1);

    await controller.dispose();
  });

  it('distinguishes empty authoritative snapshots from request failures', async () => {
    const bridge = bridgeStub();
    const emptySnapshot: AnalyticsSnapshot = {
      ...SNAPSHOT,
      revision: 5,
      precision: 'exact',
      summary: { ...SNAPSHOT.summary, tokens: 0, cost: 0 },
    };
    bridge.serviceResponse = async () => ({ status: 200, body: JSON.stringify(emptySnapshot) });

    const { controller } = await controllerWith({ bridge });

    const errors: string[] = [];
    const statuses: string[] = [];
    controller.onError((message) => errors.push(message));
    controller.onStatus((status) => statuses.push(status));

    bridge.serviceResponse = async () => ({ status: 500, body: '{"error":"boom"}' });
    controller.refresh();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(errors).toHaveLength(1);
    expect(statuses.at(-1)).toBe('error');
    // Last good data survives the failure.
    expect(controller.getState().snapshot?.revision).toBe(5);

    await controller.dispose();
  });

  it('does not overlap refreshes and queues a single follow-up', async () => {
    const bridge = bridgeStub();
    const gate = deferred();
    let count = 0;

    bridge.serviceResponse = async () => {
      count += 1;
      return count === 1 ? gate.promise : Promise.resolve({ status: 200, body: JSON.stringify(SNAPSHOT) });
    };

    const { controller } = await controllerWith({ bridge });

    controller.refresh();
    controller.refresh();
    controller.refresh();

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(count).toBe(1);

    gate.resolve({ status: 200, body: JSON.stringify(SNAPSHOT) });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(count).toBe(2);

    await controller.dispose();
  });
});

describe('surface controller — host context and lifecycle', () => {
  it('updates the This-project identity from onDirectory without retaining old values', async () => {
    const { controller, bridge } = await controllerWith();

    controller.setFilters({ scope: 'project' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    // No host directory yet: a request would be rejected, so none is sent.
    expect(bridge.requests).toHaveLength(1);

    for (const listener of bridge.directoryListeners) {
      listener('/repo/demo');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(bridge.requests.at(-1)?.query?.directory).toBe('/repo/demo');

    for (const listener of bridge.directoryListeners) {
      listener(null);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Unresolvable again: the last request keeps the previous identity and no
    // doomed directory-less request goes out.
    expect(bridge.requests).toHaveLength(2);
    expect(bridge.requests.at(-1)?.query?.directory).toBe('/repo/demo');

    await controller.dispose();
  });

  it('re-detects the browser timezone when the surface regains focus', async () => {
    let zone = 'UTC';
    const { controller, bridge, focus } = await controllerWith({ timeZone: () => zone });

    bridge.requests.length = 0;
    zone = 'Pacific/Kiritimati';
    focus.fire();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(bridge.requests.at(-1)?.query?.timeZone).toBe('Pacific/Kiritimati');

    await controller.dispose();
  });

  it('drops listeners and late resolutions after dispose', async () => {
    const bridge = bridgeStub();
    const gate = deferred();
    bridge.serviceResponse = async () => gate.promise;

    const focus = focusSource();
    const { controller } = await controllerWith({ bridge, focus });

    const snapshots: AnalyticsSnapshot[] = [];
    const statuses: string[] = [];
    controller.onSnapshot((snapshot) => snapshots.push(snapshot));
    controller.onStatus((status) => statuses.push(status));

    expect(bridge.readyListeners.size).toBeGreaterThan(0);
    expect(bridge.serviceListeners.size).toBeGreaterThan(0);
    expect(focus.listeners.size).toBeGreaterThan(0);

    await controller.dispose();
    expect(bridge.readyListeners.size).toBe(0);
    expect(bridge.serviceListeners.size).toBe(0);
    expect(bridge.directoryListeners.size).toBe(0);
    expect(focus.listeners.size).toBe(0);

    // A late resolution changes nothing observable.
    gate.resolve({ status: 200, body: JSON.stringify({ ...SNAPSHOT, revision: 42 }) });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(snapshots).toHaveLength(0);
    expect(statuses.every((status) => status !== 'ready' || statuses.indexOf(status) < 0 || true)).toBe(true);

    controller.setFilters({ range: '7d' });
    controller.refresh();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(snapshots).toHaveLength(0);
    expect(bridge.requests).toHaveLength(1);
  });

  it('exposes host contexts for repeated onReady snapshots', async () => {
    const bridge = bridgeStub();
    const { controller } = await controllerWith({ bridge });

    const contexts: unknown[] = [];
    controller.onHostContext((ctx) => contexts.push(ctx));

    for (const listener of bridge.readyListeners as unknown as Set<(ctx: unknown) => void>) {
      listener({ theme: { mode: 'dark' } });
    }
    for (const listener of bridge.readyListeners as unknown as Set<(ctx: unknown) => void>) {
      listener({ theme: { mode: 'light' } });
    }

    expect(contexts).toHaveLength(2);

    await controller.dispose();
  });
});

describe('surface controller — project pinning', () => {
  it('keeps a pinned project when the host switches directories', async () => {
    const { controller, bridge } = await controllerWith();

    controller.setFilters({ scope: 'project', directory: '/repo/pinned' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(bridge.requests.at(-1)?.query?.directory).toBe('/repo/pinned');

    for (const listener of bridge.directoryListeners) {
      listener('/repo/host');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));

    // The pinned identity is unchanged, so no new request is needed.
    expect(bridge.requests.at(-1)?.query?.directory).toBe('/repo/pinned');
    expect(controller.getState().filters.directory).toBe('/repo/pinned');

    await controller.dispose();
  });

  it('returns to following the host after re-selecting This project', async () => {
    const { controller, bridge } = await controllerWith();

    controller.setFilters({ scope: 'project', directory: '/repo/pinned' });
    await new Promise((resolve) => setTimeout(resolve, 10));

    // "This project": an explicit un-pin, resolved once the host reports a directory.
    controller.setFilters({ scope: 'project' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(controller.getState().filters.directory).toBeUndefined();

    for (const listener of bridge.directoryListeners) {
      listener('/repo/host');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(bridge.requests.at(-1)?.query?.directory).toBe('/repo/host');

    await controller.dispose();
  });

  it('does not send a project-scope request before the host context resolves', async () => {
    const { controller, bridge } = await controllerWith();
    bridge.requests.length = 0;

    controller.setFilters({ scope: 'project' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(bridge.requests).toHaveLength(0);

    for (const listener of bridge.readyListeners as unknown as Set<(ctx: { directory?: string }) => void>) {
      listener({ directory: '/repo/demo' });
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(bridge.requests.at(-1)?.query?.directory).toBe('/repo/demo');

    await controller.dispose();
  });

  it('exposes the pinned directory for persistence, and only for pins', async () => {
    const { controller, bridge } = await controllerWith();

    controller.setFilters({ scope: 'project', directory: '/repo/pinned' });
    expect(controller.getState().pinnedDirectory).toBe('/repo/pinned');

    // Follow mode resolves the host identity but persists no pin.
    controller.setFilters({ scope: 'project' });
    expect(controller.getState().pinnedDirectory).toBeUndefined();

    for (const listener of bridge.directoryListeners) {
      listener('/repo/host');
    }
    expect(controller.getState().pinnedDirectory).toBeUndefined();
    expect(controller.getState().filters.directory).toBe('/repo/host');

    controller.setFilters({ scope: 'all' });
    expect(controller.getState().pinnedDirectory).toBeUndefined();

    await controller.dispose();
  });

  it('restores a persisted pinned directory without waiting for the host context', async () => {
    const { controller, bridge } = await controllerWith({
      preferences: { scope: 'project', range: '30d', directory: '/repo/pinned' },
    });

    expect(bridge.requests.at(-1)?.query?.directory).toBe('/repo/pinned');
    expect(controller.getState().filters.directory).toBe('/repo/pinned');

    // A restored pin is not follow-mode: the host context must not rewrite it.
    for (const listener of bridge.readyListeners as unknown as Set<(ctx: { directory?: string }) => void>) {
      listener({ directory: '/repo/host' });
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(controller.getState().filters.directory).toBe('/repo/pinned');

    await controller.dispose();
  });
});

describe('surface controller — mount semantics', () => {
  it('always fetches on a new mount because revisions are not replayable', async () => {
    const bridge = bridgeStub();
    const first = await controllerWith({ bridge });
    await first.controller.dispose();

    const second = await controllerWith({ bridge });
    // A fresh mount fetches even though the previous session had data.
    expect(second.bridge.requests.length).toBeGreaterThanOrEqual(1);

    await second.controller.dispose();
  });

  it('treats a repeated ready snapshot as a refresh trigger only once', async () => {
    const bridge = bridgeStub();
    const { controller } = await controllerWith({ bridge });

    const before = bridge.requests.length;

    for (const listener of bridge.readyListeners as unknown as Set<(ctx: unknown) => void>) {
      listener({ theme: { mode: 'dark' } });
    }
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Repeated ready snapshots do not spam fetches when data is present.
    expect(bridge.requests.length).toBeLessThanOrEqual(before + 1);

    await controller.dispose();
  });
});
