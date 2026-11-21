import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSyncEngine, type SyncEngine } from '../../src/service/sync';
import { sessionFingerprint } from '../../src/service/normalize';
import type { OpenCodeReader } from '../../src/service/opencode';
import type { AnalyticsFilters, CounterKind, SessionRecord, TokenUsage, UsageEvent } from '../../src/shared/analytics-types';

const dataDirs: string[] = [];

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(async () => {
  await Promise.all(
    dataDirs.splice(0).map((dir) =>
      rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => undefined),
    ),
  );
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'analytics-sync-'));
  dataDirs.push(dir);
  return dir;
}

const NOW = Date.parse('2026-11-18T12:00:00Z');
const DAY_MS = 86_400_000;

const FILTERS: AnalyticsFilters = {
  scope: 'all',
  range: '30d',
  surface: 'page',
  timeZone: 'UTC',
};

function sessionRecord(id: string, updatedDaysAgo: number, overrides: Partial<SessionRecord> = {}): SessionRecord {
  const updated = NOW - updatedDaysAgo * DAY_MS;

  return {
    sessionId: id,
    title: `Session ${id}`,
    directory: '/repo/demo',
    timeCreated: updated - DAY_MS,
    timeUpdated: updated,
    tokens: { input: 10, output: 5, reasoning: 1, cache: { read: 2, write: 0 } },
    cost: 0.2,
    ...overrides,
  };
}

function assistantEvent(sessionId: string, overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    sessionId,
    timestamp: NOW - DAY_MS,
    providerID: 'zai',
    modelID: 'glm-5',
    tokens: { input: 6, output: 3, reasoning: 1, cache: { read: 2, write: 0 } },
    cost: 0.1,
    messageCount: 1,
    source: 'assistant',
    estimated: false,
    ...overrides,
  };
}

type FakeReaderOptions = {
  messageDelayMs?: number;
  sessionDelayMs?: number;
  failMessageReadsFor?: Record<string, number>;
  sessionGate?: (call: number) => Promise<{ ignoreAbort?: boolean } | void>;
  getSessionGate?: (sessionId: string, call: number) => Promise<{ ignoreAbort?: boolean } | void>;
  messageGate?: (session: SessionRecord, call: number) => Promise<{ ignoreAbort?: boolean } | void>;
};

function createFakeReader(options: FakeReaderOptions = {}) {
  const sessions: SessionRecord[] = [];
  const messages = new Map<string, unknown[]>();
  const requestLog: { kind: 'sessions' | 'messages' | 'get'; sessionId?: string }[] = [];
  const failureCounts = new Map<string, number>(Object.entries(options.failMessageReadsFor ?? {}).map(([id, count]) => [id, count]));
  let messageCalls = 0;
  let sessionCalls = 0;
  let getSessionCalls = 0;
  let messageCompletions = 0;
  let sessionCompletions = 0;
  let inFlight = 0;
  let maxConcurrent = 0;
  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const reader: OpenCodeReader & {
    sessions: SessionRecord[];
    messages: Map<string, unknown[]>;
    requestLog: typeof requestLog;
    maxConcurrent: () => number;
    completedMessageReads: () => number;
    completedSessionReads: () => number;
  } = {
    sessions,
    messages,
    requestLog,
    maxConcurrent: () => maxConcurrent,
    completedMessageReads: () => messageCompletions,
    completedSessionReads: () => sessionCompletions,

    async *listSessions(signal?: AbortSignal): AsyncIterable<SessionRecord> {
      requestLog.push({ kind: 'sessions' });
      sessionCalls += 1;
      // Deferred scans must observe the session list as it existed when the
      // read began, even if reset replaces the fixture before release.
      const payload = [...sessions];
      const gate = await options.sessionGate?.(sessionCalls);

      if (signal?.aborted && !gate?.ignoreAbort) {
        return;
      }

      for (const session of payload) {
        yield session;
      }

      sessionCompletions += 1;
    },

    async *listAssistantMessages(session: SessionRecord, signal?: AbortSignal): AsyncIterable<unknown> {
      requestLog.push({ kind: 'messages', sessionId: session.sessionId });
      messageCalls += 1;
      // Snapshot the pending read: a deferred pre-reset fetch must return its
      // original payload even after the fixture queue changes during the reset.
      const payload = [...(messages.get(session.sessionId) ?? [])];
      const gate = await options.messageGate?.(session, messageCalls);
      const remaining = failureCounts.get(session.sessionId) ?? 0;

      if (remaining > 0) {
        failureCounts.set(session.sessionId, remaining - 1);
        throw new (class extends Error {
          retryable = true;
        })('injected message failure');
      }

      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);

      try {
        if (options.messageDelayMs) {
          await delay(options.messageDelayMs);
        }

        if (signal?.aborted && !gate?.ignoreAbort) {
          return;
        }

        for (const event of payload) {
          yield event;
        }

        messageCompletions += 1;
      } finally {
        inFlight -= 1;
      }
    },

    async *streamEvents(): AsyncIterable<never> {
      // Tests deliver live events through the injected stream hook instead.
      yield* ([] as never[]);
    },

    async getSession(sessionId: string): Promise<SessionRecord | null> {
      requestLog.push({ kind: 'get', sessionId });
      getSessionCalls += 1;
      // Deferred deletion confirmations must preserve their pre-reset answer,
      // even when reset/start changes the fixture before release.
      const found = sessions.find((session) => session.sessionId === sessionId) ?? null;
      await options.getSessionGate?.(sessionId, getSessionCalls);

      return found;
    },
  };

  return reader;
}

type StreamHook = {
  deliver(event:
    | { type: 'session.usage.updated'; sessionID: string; cost: number; tokens: TokenUsage }
    | { type: 'session.deleted'; sessionID: string }
    | { type: 'counter'; kind: CounterKind; sessionID: string; timestamp: number; permissionID?: string }): void;
  disconnect(): void;
};

function makeEngine(reader: ReturnType<typeof createFakeReader>, overrides: Record<string, unknown> = {}): { engine: SyncEngine; stream: StreamHook } {
  let onEvent: ((event: Parameters<StreamHook['deliver']>[0]) => void) | null = null;
  let onDisconnect: (() => void) | null = null;

  const stream: StreamHook = {
    deliver(event) {
      onEvent?.(event);
    },
    disconnect() {
      onDisconnect?.();
    },
  };

  const engine = createSyncEngine({
    reader,
    liveSyncDebounceMs: 0,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store: undefined as any,
    stream: {
      subscribe(handlers: { onEvent: (event: Parameters<StreamHook['deliver']>[0]) => void; onDisconnect: () => void }) {
        onEvent = handlers.onEvent;
        onDisconnect = handlers.onDisconnect;
        return () => {
          onEvent = null;
          onDisconnect = null;
        };
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...(overrides as any),
  });

  return { engine, stream };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000, stepMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }

  throw new Error('condition not met in time');
}

describe('sync engine — bootstrap and priority', () => {
  it('makes session snapshots available before message detail completes', async () => {
    const reader = createFakeReader({ messageDelayMs: 60 });
    reader.sessions.push(sessionRecord('ses_a', 1), sessionRecord('ses_b', 2));
    const store = (await import('../../src/service/store')).openAnalyticsStore;
    const analyticsStore = await store(await tempDir());
    const { engine } = makeEngine(reader, { store: analyticsStore });

    await engine.start();

    // Bootstrap finished; message detail is still in flight.
    const provisional = analyticsStore.listSessions();
    expect(provisional).toHaveLength(2);
    expect(provisional.every((record) => record.state === 'pending')).toBe(true);
    expect(provisional.every((record) => record.events.every((event) => event.source === 'session-snapshot'))).toBe(true);

    await waitFor(() => analyticsStore.listSessions().every((record) => record.state === 'complete'));
    expect(analyticsStore.listSessions().every((record) => record.events.every((event) => event.source !== 'session-snapshot'))).toBe(true);

    await engine.stop();
    await analyticsStore.close();
  });

  it('schedules the current selection first, then comparison, then newer-to-older history', async () => {
    const reader = createFakeReader();
    reader.sessions.push(
      sessionRecord('older', 100),
      sessionRecord('prev_old', 50),
      sessionRecord('prev_new', 40),
      sessionRecord('current_old', 10),
      sessionRecord('current_new', 2),
    );

    const storeModule = await import('../../src/service/store');
    const analyticsStore = await storeModule.openAnalyticsStore(await tempDir());
    const { engine } = makeEngine(reader, { store: analyticsStore });

    engine.setPriority(FILTERS);
    await engine.start();
    await waitFor(() => analyticsStore.listSessions().every((record) => record.state === 'complete'));

    const order = reader.requestLog.filter((entry) => entry.kind === 'messages').map((entry) => entry.sessionId);

    expect(order).toEqual(['current_new', 'current_old', 'prev_new', 'prev_old', 'older']);

    await engine.stop();
    await analyticsStore.close();
  });

  it('bounds message reads to four concurrent workers', async () => {
    const reader = createFakeReader({ messageDelayMs: 25 });
    reader.sessions.push(...Array.from({ length: 10 }, (_, index) => sessionRecord(`ses_${index}`, index)));

    const storeModule = await import('../../src/service/store');
    const analyticsStore = await storeModule.openAnalyticsStore(await tempDir());
    const { engine } = makeEngine(reader, { store: analyticsStore });

    await engine.start();
    await waitFor(() => analyticsStore.listSessions().every((record) => record.state === 'complete'));

    expect(reader.maxConcurrent()).toBeLessThanOrEqual(4);
    expect(reader.maxConcurrent()).toBeGreaterThan(1);

    await engine.stop();
    await analyticsStore.close();
  });

  it('checkpoints each completed session and emits strictly increasing revisions', async () => {
    const reader = createFakeReader();
    reader.sessions.push(...Array.from({ length: 4 }, (_, index) => sessionRecord(`ses_${index}`, index)));

    const storeModule = await import('../../src/service/store');
    const analyticsStore = await storeModule.openAnalyticsStore(await tempDir());
    const { engine } = makeEngine(reader, { store: analyticsStore, revisionCoalesceMs: 0 });

    const revisions: number[] = [];
    engine.onRevision((revision) => revisions.push(revision));

    await engine.start();
    await waitFor(() => analyticsStore.listSessions().every((record) => record.state === 'complete'));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(revisions.length).toBeGreaterThanOrEqual(8);
    expect([...revisions].sort((a, b) => a - b)).toEqual(revisions);
    expect(new Set(revisions).size).toBe(revisions.length);

    await engine.stop();
    await analyticsStore.close();
  });

  it('replaces the allocation when a live fingerprint change invalidates detail', async () => {
    const reader = createFakeReader();
    reader.sessions.push(sessionRecord('ses_live', 1));
    reader.messages.set('ses_live', [assistantEvent('ses_live')]);

    const storeModule = await import('../../src/service/store');
    const analyticsStore = await storeModule.openAnalyticsStore(await tempDir());
    const { engine, stream } = makeEngine(reader, { store: analyticsStore });

    await engine.start();
    await waitFor(() => analyticsStore.listSessions().every((record) => record.state === 'complete'));

    // Live usage update: bigger totals arrive as a total snapshot.
    stream.deliver({
      type: 'session.usage.updated',
      sessionID: 'ses_live',
      cost: 0.9,
      tokens: { input: 40, output: 20, reasoning: 4, cache: { read: 8, write: 2 } },
    });

    await waitFor(() => analyticsStore.listSessions()[0]?.state === 'pending');
    const invalidated = analyticsStore.listSessions()[0]!;

    // The snapshot event replaces detailed events; nothing is appended.
    expect(invalidated.events).toHaveLength(1);
    expect(invalidated.events[0]?.source).toBe('session-snapshot');
    expect(invalidated.events[0]?.cost).toBeCloseTo(0.9, 9);
    expect(invalidated.fingerprint).toBe(sessionFingerprint(invalidated.session));

    // Detail is re-synced after invalidation.
    await waitFor(() => analyticsStore.listSessions()[0]?.state === 'complete');
    expect(reader.requestLog.filter((entry) => entry.kind === 'messages' && entry.sessionId === 'ses_live')).toHaveLength(2);

    await engine.stop();
    await analyticsStore.close();
  });
});

describe('sync engine — retries, live events, and reconciliation', () => {
  it('retries failed message reads with capped backoff and keeps provisional data', async () => {
    const reader = createFakeReader({
      failMessageReadsFor: { ses_retry: 2 },
      messageDelayMs: 5,
    });
    reader.sessions.push(sessionRecord('ses_retry', 1));
    reader.messages.set('ses_retry', [assistantEvent('ses_retry')]);

    const storeModule = await import('../../src/service/store');
    const analyticsStore = await storeModule.openAnalyticsStore(await tempDir());
    const { engine } = makeEngine(reader, { store: analyticsStore, retryBaseDelayMs: 20, retryCapDelayMs: 80 });

    await engine.start();

    await waitFor(() => analyticsStore.listSessions()[0]?.state === 'complete', 4_000);

    const record = analyticsStore.listSessions()[0]!;
    expect(record.attempts).toBe(3);
    expect(reader.requestLog.filter((entry) => entry.kind === 'messages' && entry.sessionId === 'ses_retry')).toHaveLength(3);

    await engine.stop();
    await analyticsStore.close();
  });

  it('treats repeated usage.updated events as total snapshots, never deltas', async () => {
    const reader = createFakeReader({ messageDelayMs: 200 });
    reader.sessions.push(sessionRecord('ses_totals', 1));

    const storeModule = await import('../../src/service/store');
    const analyticsStore = await storeModule.openAnalyticsStore(await tempDir());
    const { engine, stream } = makeEngine(reader, { store: analyticsStore });

    await engine.start();
    await waitFor(() => analyticsStore.listSessions().length === 1);

    stream.deliver({ type: 'session.usage.updated', sessionID: 'ses_totals', cost: 1, tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } } });
    stream.deliver({ type: 'session.usage.updated', sessionID: 'ses_totals', cost: 2, tokens: { input: 20, output: 5, reasoning: 0, cache: { read: 0, write: 0 } } });
    stream.deliver({ type: 'session.usage.updated', sessionID: 'ses_totals', cost: 3, tokens: { input: 30, output: 5, reasoning: 0, cache: { read: 0, write: 0 } } });

    await new Promise((resolve) => setTimeout(resolve, 30));
    const record = analyticsStore.listSessions()[0]!;

    // Exactly one provisional event with the latest totals — never 1+2+3.
    const snapshots = record.events.filter((event) => event.source === 'session-snapshot');
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.cost).toBeCloseTo(3, 9);
    expect(snapshots[0]?.tokens.input).toBe(30);

    await engine.stop();
    await analyticsStore.close();
  });

  it('downloads detail once for a burst of live usage events', async () => {
    const reader = createFakeReader();
    reader.sessions.push(sessionRecord('ses_burst', 1));
    reader.messages.set('ses_burst', [assistantEvent('ses_burst')]);

    const storeModule = await import('../../src/service/store');
    const analyticsStore = await storeModule.openAnalyticsStore(await tempDir());
    const { engine, stream } = makeEngine(reader, { store: analyticsStore, liveSyncDebounceMs: 120 });

    await engine.start();
    await waitFor(() => analyticsStore.listSessions().every((record) => record.state === 'complete'));
    const messageReads = () => reader.requestLog.filter((entry) => entry.kind === 'messages' && entry.sessionId === 'ses_burst').length;
    const before = messageReads();

    for (const input of [20, 30, 40]) {
      stream.deliver({ type: 'session.usage.updated', sessionID: 'ses_burst', cost: input / 10, tokens: { input, output: 5, reasoning: 0, cache: { read: 0, write: 0 } } });
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(messageReads()).toBe(before);
    await waitFor(() => messageReads() === before + 1 && analyticsStore.listSessions()[0]?.state !== 'pending');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(messageReads()).toBe(before + 1);

    await engine.stop();
    await analyticsStore.close();
  });

  it('does not invalidate a session on reconcile when a live event already carried the same totals', async () => {
    const reader = createFakeReader();
    reader.sessions.push(sessionRecord('ses_same', 1));
    reader.messages.set('ses_same', [assistantEvent('ses_same')]);

    const storeModule = await import('../../src/service/store');
    const analyticsStore = await storeModule.openAnalyticsStore(await tempDir());
    const { engine, stream } = makeEngine(reader, { store: analyticsStore });

    await engine.start();
    await waitFor(() => analyticsStore.listSessions().every((record) => record.state === 'complete'));

    const totals = { input: 40, output: 20, reasoning: 4, cache: { read: 8, write: 2 } };
    stream.deliver({ type: 'session.usage.updated', sessionID: 'ses_same', cost: 0.9, tokens: totals });
    await waitFor(() => analyticsStore.listSessions()[0]?.state === 'complete' && analyticsStore.listSessions()[0]?.session.cost === 0.9);
    const messageReads = () => reader.requestLog.filter((entry) => entry.kind === 'messages' && entry.sessionId === 'ses_same').length;
    const before = messageReads();

    // The runtime later reports the same totals with its own (earlier) clock.
    reader.sessions[0] = sessionRecord('ses_same', 1, { cost: 0.9, tokens: totals, timeUpdated: Date.now() - 1_000 });
    await engine.reconcile();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(analyticsStore.listSessions()[0]?.state).toBe('complete');
    expect(messageReads()).toBe(before);

    await engine.stop();
    await analyticsStore.close();
  });

  it('removes deleted sessions after reconciliation confirms them', async () => {
    const reader = createFakeReader();
    reader.sessions.push(sessionRecord('ses_gone', 1), sessionRecord('ses_kept', 2));

    const storeModule = await import('../../src/service/store');
    const analyticsStore = await storeModule.openAnalyticsStore(await tempDir());
    const { engine } = makeEngine(reader, { store: analyticsStore });

    await engine.start();
    await waitFor(() => analyticsStore.listSessions().every((record) => record.state === 'complete'));

    // Mutate the fake's session list in place: the generator closes over it.
    const goneIndex = reader.sessions.findIndex((session) => session.sessionId === 'ses_gone');
    reader.sessions.splice(goneIndex, 1);
    await engine.reconcile();

    const ids = analyticsStore.listSessions().map((record) => record.sessionId);
    expect(ids).toEqual(['ses_kept']);

    await engine.stop();
    await analyticsStore.close();
  });

  it('records stream counters and pairs permission waits', async () => {
    const reader = createFakeReader();
    reader.sessions.push(sessionRecord('ses_counter', 1));

    const storeModule = await import('../../src/service/store');
    const analyticsStore = await storeModule.openAnalyticsStore(await tempDir());
    const { engine, stream } = makeEngine(reader, { store: analyticsStore });

    await engine.start();
    await waitFor(() => analyticsStore.listSessions().every((record) => record.state === 'complete'));

    const base = Date.now();
    stream.deliver({ type: 'counter', kind: 'executionFailed', sessionID: 'ses_counter', timestamp: base });
    stream.deliver({ type: 'counter', kind: 'permissionAsked', sessionID: 'ses_counter', timestamp: base + 1_000, permissionID: 'perm_1' });
    stream.deliver({ type: 'counter', kind: 'permissionReplied', sessionID: 'ses_counter', timestamp: base + 6_000, permissionID: 'perm_1' });

    await waitFor(() => analyticsStore.listCounters().length === 4);
    const counters = analyticsStore.listCounters();

    expect(counters.map((counter) => counter.kind)).toEqual(['executionFailed', 'permissionAsked', 'permissionReplied', 'permissionWait']);
    expect(counters[3]?.ms).toBe(5_000);

    await engine.stop();
    await analyticsStore.close();
  });

  it('refreshes session metadata without invalidating a matching fingerprint', async () => {
    const reader = createFakeReader();
    reader.sessions.push(sessionRecord('ses_meta', 1));

    const storeModule = await import('../../src/service/store');
    const analyticsStore = await storeModule.openAnalyticsStore(await tempDir());
    const { engine } = makeEngine(reader, { store: analyticsStore, revisionCoalesceMs: 0 });
    const revisions: number[] = [];
    engine.onRevision((revision) => revisions.push(revision));

    await engine.start();
    await waitFor(() => analyticsStore.listSessions().every((record) => record.state === 'complete'));
    const before = analyticsStore.listSessions()[0]!;
    const revisionBefore = analyticsStore.currentRevision();
    revisions.length = 0;

    // Same fingerprint inputs, new title/outcome/directory metadata.
    reader.sessions[0] = sessionRecord('ses_meta', 1, {
      title: 'Renamed',
      outcome: 'succeeded',
      directory: '/repo/moved',
    });
    await engine.reconcile();
    await waitFor(() => analyticsStore.listSessions()[0]?.session.directory === '/repo/moved');

    const after = analyticsStore.listSessions()[0]!;
    expect(after.fingerprint).toBe(before.fingerprint);
    expect(after.state).toBe('complete');
    expect(after.session.title).toBe('Renamed');
    expect(after.session.outcome).toBe('succeeded');
    expect(analyticsStore.currentRevision()).toBeGreaterThan(revisionBefore);
    await waitFor(() => revisions.includes(analyticsStore.currentRevision()));

    await engine.stop();
    await analyticsStore.close();
  });

  it('invalidates changed fingerprints on reconcile and re-syncs detail', async () => {
    const reader = createFakeReader();
    reader.sessions.push(sessionRecord('ses_change', 1));

    const storeModule = await import('../../src/service/store');
    const analyticsStore = await storeModule.openAnalyticsStore(await tempDir());
    const { engine } = makeEngine(reader, { store: analyticsStore });

    await engine.start();
    await waitFor(() => analyticsStore.listSessions().every((record) => record.state === 'complete'));

    const before = reader.requestLog.filter((entry) => entry.kind === 'messages').length;

    // The runtime reports the session with new usage: fingerprint changes.
    reader.sessions[0] = sessionRecord('ses_change', 1, { cost: 0.7, tokens: { input: 50, output: 25, reasoning: 5, cache: { read: 4, write: 1 } } });
    await engine.reconcile();

    await waitFor(() => analyticsStore.listSessions()[0]?.state === 'complete');
    expect(reader.requestLog.filter((entry) => entry.kind === 'messages').length).toBeGreaterThan(before);

    const record = analyticsStore.listSessions()[0]!;
    expect(record.events.every((event) => event.source !== 'session-snapshot')).toBe(true);
    expect(record.session.cost).toBeCloseTo(0.7, 9);

    await engine.stop();
    await analyticsStore.close();
  });

  it('schedules periodic reconciliation', async () => {
    vi.useFakeTimers();
    try {
      const reader = createFakeReader();
      reader.sessions.push(sessionRecord('ses_periodic', 1));

      const storeModule = await import('../../src/service/store');
      const analyticsStore = await storeModule.openAnalyticsStore(await tempDir());
      const { engine } = makeEngine(reader, { store: analyticsStore, reconcileIntervalMs: 1_000 });

      await engine.start();
      const scans = () => reader.requestLog.filter((entry) => entry.kind === 'sessions').length;

      await vi.advanceTimersByTimeAsync(2_500);
      expect(scans()).toBeGreaterThanOrEqual(3);

      await engine.stop();
      await analyticsStore.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop aborts in-flight work and prevents further requests', async () => {
    const reader = createFakeReader({ messageDelayMs: 300 });
    reader.sessions.push(...Array.from({ length: 8 }, (_, index) => sessionRecord(`ses_stop_${index}`, index)));

    const storeModule = await import('../../src/service/store');
    const analyticsStore = await storeModule.openAnalyticsStore(await tempDir());
    const { engine } = makeEngine(reader, { store: analyticsStore });

    await engine.start();
    await waitFor(() => reader.requestLog.some((entry) => entry.kind === 'messages'));

    await engine.stop();
    const requestsAtStop = reader.requestLog.length;
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(reader.requestLog.length).toBe(requestsAtStop);
    expect(reader.requestLog.filter((entry) => entry.kind === 'messages').length).toBeLessThan(8);

    await analyticsStore.close();
  });

  it('waits for an in-flight detail read before stop returns', async () => {
    let releaseBlocked!: () => void;
    const reader = createFakeReader({
      messageGate: async (_session, call) => {
        if (call === 1) {
          await new Promise<void>((resolve) => {
            releaseBlocked = resolve;
          });

          return { ignoreAbort: true };
        }

        return undefined;
      },
    });
    reader.sessions.push(sessionRecord('ses_stop_join', 1));
    reader.messages.set('ses_stop_join', [
      {
        id: 'msg_stop_join',
        type: 'assistant',
        agent: 'build',
        model: { id: 'glm-5', providerID: 'zai' },
        tokens: { input: 6, output: 3, reasoning: 1, cache: { read: 2, write: 0 } },
        cost: 0.1,
        time: { created: NOW - DAY_MS },
        content: [],
      },
    ]);

    const storeModule = await import('../../src/service/store');
    const analyticsStore = await storeModule.openAnalyticsStore(await tempDir());
    const { engine } = makeEngine(reader, { store: analyticsStore, workers: 1 });

    await engine.start();
    await waitFor(() => reader.requestLog.filter((entry) => entry.kind === 'messages').length === 1);

    const stopping = engine.stop();
    let stopped = false;
    void stopping.then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(stopped).toBe(false);
    releaseBlocked();
    await stopping;
    expect(stopped).toBe(true);

    await engine.stop();
    await analyticsStore.close();
  });

  it('drops a pre-reset detail read that completes after a new generation syncs', async () => {
    let releaseStale!: () => void;
    const reader = createFakeReader({
      messageGate: async (_session, call) => {
        if (call === 1) {
          await new Promise<void>((resolve) => {
            releaseStale = resolve;
          });

          return { ignoreAbort: true };
        }

        return undefined;
      },
    });
    reader.sessions.push(sessionRecord('ses_generation', 1));
    const rawMessage = (toolCalls: number): Record<string, unknown> => ({
      id: `msg_generation_${toolCalls}`,
      type: 'assistant',
      agent: 'build',
      model: { id: 'glm-5', providerID: 'zai' },
      tokens: { input: 6, output: 3, reasoning: 1, cache: { read: 2, write: 0 } },
      cost: 0.1,
      time: { created: NOW - DAY_MS },
      content: Array.from({ length: toolCalls }, (_, index) => ({
        id: `tool_${toolCalls}_${index}`,
        type: 'tool',
        state: { status: 'completed' },
      })),
    });
    reader.messages.set('ses_generation', [rawMessage(7)]);

    const storeModule = await import('../../src/service/store');
    const analyticsStore = await storeModule.openAnalyticsStore(await tempDir());
    const { engine } = makeEngine(reader, { store: analyticsStore, workers: 1 });

    await engine.start();
    await waitFor(() => reader.requestLog.filter((entry) => entry.kind === 'messages').length === 1);

    const stopping = engine.stop();
    releaseStale();
    await stopping;
    await waitFor(() => reader.completedMessageReads() >= 1);

    await analyticsStore.reset();
    reader.messages.set('ses_generation', [rawMessage(1)]);
    await engine.start();
    await waitFor(() => analyticsStore.listSessions()[0]?.state === 'complete');
    await waitFor(() => reader.completedMessageReads() >= 2);

    const record = analyticsStore.listSessions()[0]!;
    const toolCalls = record.events.reduce((total, event) => total + (event.toolCalls ?? 0), 0);
    expect(record.state).toBe('complete');
    expect(toolCalls).toBe(1);

    await engine.stop();
    await analyticsStore.close();
  });

  it('drops a stale forced scan that completes after a new generation starts', async () => {
    let releaseStale!: () => void;
    const reader = createFakeReader({
      sessionGate: async (call) => {
        if (call === 2) {
          await new Promise<void>((resolve) => {
            releaseStale = resolve;
          });

          return { ignoreAbort: true };
        }

        return undefined;
      },
    });
    const oldSession = sessionRecord('ses_scan_generation', 1, { title: 'Old title' });
    const newSession = sessionRecord('ses_scan_generation', 1, {
      title: 'New title',
      timeUpdated: NOW,
      cost: 0.8,
    });
    const newFingerprint = sessionFingerprint(newSession);

    const storeModule = await import('../../src/service/store');
    const analyticsStore = await storeModule.openAnalyticsStore(await tempDir());
    const { engine } = makeEngine(reader, { store: analyticsStore, workers: 0 });

    await engine.start();
    reader.sessions.push(oldSession);

    const refreshing = engine.refresh();
    await waitFor(() => reader.requestLog.filter((entry) => entry.kind === 'sessions').length === 2);
    await engine.stop();

    await analyticsStore.reset();
    reader.sessions.length = 0;
    reader.sessions.push(newSession);
    await engine.start();
    await waitFor(() => analyticsStore.getSession('ses_scan_generation')?.fingerprint === newFingerprint);

    releaseStale();
    await refreshing;
    await waitFor(() => reader.completedSessionReads() >= 2);

    expect(analyticsStore.getSession('ses_scan_generation')?.fingerprint).toBe(newFingerprint);

    await engine.stop();
    await analyticsStore.close();
  });

  it('drops a stale deletion confirmation that completes after a new generation starts', async () => {
    let releaseStale!: () => void;
    const reader = createFakeReader({
      getSessionGate: async (sessionId, call) => {
        if (sessionId === 'ses_deletion_generation' && call === 1) {
          await new Promise<void>((resolve) => {
            releaseStale = resolve;
          });

          return { ignoreAbort: true };
        }

        return undefined;
      },
    });
    const oldSession = sessionRecord('ses_deletion_generation', 1, { title: 'Old title' });
    const newSession = sessionRecord('ses_deletion_generation', 1, {
      title: 'New title',
      timeUpdated: NOW,
      cost: 0.8,
    });
    const newFingerprint = sessionFingerprint(newSession);
    reader.sessions.push(oldSession);

    const storeModule = await import('../../src/service/store');
    const analyticsStore = await storeModule.openAnalyticsStore(await tempDir());
    const { engine } = makeEngine(reader, { store: analyticsStore, workers: 0, reconcileIntervalMs: 0 });

    await engine.start();
    await waitFor(() => analyticsStore.getSession('ses_deletion_generation')?.fingerprint === sessionFingerprint(oldSession));
    reader.sessions.length = 0;

    const refreshing = engine.refresh();
    await waitFor(() => reader.requestLog.filter((entry) => entry.kind === 'get').length === 1);
    await engine.stop();

    await analyticsStore.reset();
    reader.sessions.push(newSession);
    await engine.start();
    await waitFor(() => analyticsStore.getSession('ses_deletion_generation')?.fingerprint === newFingerprint);

    releaseStale();
    await refreshing;

    expect(analyticsStore.getSession('ses_deletion_generation')?.fingerprint).toBe(newFingerprint);

    await engine.stop();
    await analyticsStore.close();
  });

  it('drops a stale live usage write that completes after a new generation starts', async () => {
    const oldSession = sessionRecord('ses_live_generation', 1, { title: 'Old title' });
    const newSession = sessionRecord('ses_live_generation', 1, {
      title: 'New title',
      timeUpdated: NOW,
      cost: 0.8,
    });
    const newFingerprint = sessionFingerprint(newSession);
    const reader = createFakeReader();
    reader.sessions.push(oldSession);

    const storeModule = await import('../../src/service/store');
    const analyticsStore = await storeModule.openAnalyticsStore(await tempDir());
    const { engine, stream } = makeEngine(reader, { store: analyticsStore, workers: 0 });
    const originalUpsert = analyticsStore.upsertSession.bind(analyticsStore);
    let releaseUpsert!: () => void;
    let heldWrites = 0;
    let holdLiveWrite = false;

    analyticsStore.upsertSession = (async (record) => {
      if (holdLiveWrite && record.session.cost === 0.4) {
        heldWrites += 1;
        holdLiveWrite = false;
        await new Promise<void>((resolve) => {
          releaseUpsert = resolve;
        });
      }

      return originalUpsert(record);
    }) as typeof analyticsStore.upsertSession;

    await engine.start();
    await waitFor(() => analyticsStore.getSession('ses_live_generation')?.state === 'pending');

    holdLiveWrite = true;
    stream.deliver({
      type: 'session.usage.updated',
      sessionID: 'ses_live_generation',
      cost: 0.4,
      tokens: { input: 40, output: 20, reasoning: 4, cache: { read: 8, write: 2 } },
    });
    await waitFor(() => heldWrites >= 1);

    const stopping = engine.stop();
    let stopped = false;
    void stopping.then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stopped).toBe(false);
    releaseUpsert();
    await stopping;

    await analyticsStore.reset();
    reader.sessions.length = 0;
    reader.sessions.push(newSession);
    await engine.start();
    await waitFor(() => analyticsStore.getSession('ses_live_generation')?.fingerprint === newFingerprint);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(analyticsStore.getSession('ses_live_generation')?.fingerprint).toBe(newFingerprint);

    await engine.stop();
    await analyticsStore.close();
  });

  it('forces reconciliation when the event stream resets', async () => {
    const reader = createFakeReader();
    reader.sessions.push(sessionRecord('ses_reset', 1));

    const storeModule = await import('../../src/service/store');
    const analyticsStore = await storeModule.openAnalyticsStore(await tempDir());
    const { engine, stream } = makeEngine(reader, { store: analyticsStore });

    await engine.start();
    await waitFor(() => analyticsStore.listSessions().every((record) => record.state === 'complete'));

    const scansBefore = reader.requestLog.filter((entry) => entry.kind === 'sessions').length;
    stream.disconnect();

    await waitFor(() => reader.requestLog.filter((entry) => entry.kind === 'sessions').length > scansBefore, 2_000);

    await engine.stop();
    await analyticsStore.close();
  });
});

describe('sync engine — resilience and resume', () => {
  async function openStore(dir?: string) {
    const storeModule = await import('../../src/service/store');
    return storeModule.openAnalyticsStore(dir ?? (await tempDir()));
  }

  it('survives a failing session scan on stream disconnect without unhandled rejections', async () => {
    const reader = createFakeReader();
    reader.sessions.push(sessionRecord('ses_down', 1));
    const store = await openStore();
    const errors: string[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    const { engine, stream } = makeEngine(reader, { store, onError: (context: string) => errors.push(context) });
    await engine.start();
    await waitFor(() => store.listSessions().every((record) => record.state === 'complete'));

    reader.listSessions = async function* () {
      throw new Error('opencode down');
      yield undefined as never;
    };
    stream.disconnect();
    stream.deliver({ type: 'session.deleted', sessionID: 'ses_down' });
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(unhandled).toEqual([]);
    expect(errors.length).toBeGreaterThan(0);

    process.off('unhandledRejection', onUnhandled);
    await engine.stop();
    await store.close();
  });

  it('keeps retrying the bootstrap scan instead of throwing from start()', async () => {
    const reader = createFakeReader();
    reader.sessions.push(sessionRecord('ses_boot', 1));
    reader.messages.set('ses_boot', [assistantEvent('ses_boot')]);
    const original = reader.listSessions.bind(reader);
    let failures = 2;
    reader.listSessions = (signal?: AbortSignal) => {
      if (failures > 0) {
        failures -= 1;
        return (async function* () {
          throw new Error('not ready');
          yield undefined as never;
        })();
      }

      return original(signal);
    };

    const store = await openStore();
    const { engine } = makeEngine(reader, { store, retryBaseDelayMs: 10, retryCapDelayMs: 20, onError: () => undefined });

    await expect(engine.start()).resolves.toBeUndefined();
    expect(engine.sessionListComplete()).toBe(false);

    await waitFor(() => engine.sessionListComplete(), 3_000);
    await waitFor(() => store.listSessions()[0]?.state === 'complete', 3_000);

    await engine.stop();
    await store.close();
  });

  it('resumes unfinished sessions after a restart', async () => {
    const dir = await tempDir();
    const reader = createFakeReader({ messageDelayMs: 40 });
    for (let index = 0; index < 5; index += 1) {
      reader.sessions.push(sessionRecord(`ses_${index}`, index + 1));
      reader.messages.set(`ses_${index}`, [assistantEvent(`ses_${index}`)]);
    }

    let store = await openStore(dir);
    let { engine } = makeEngine(reader, { store });
    await engine.start();
    await waitFor(() => store.listSessions().some((record) => record.state === 'complete'));
    await engine.stop();
    await store.close();

    store = await openStore(dir);
    expect(store.listSessions().some((record) => record.state !== 'complete')).toBe(true);
    ({ engine } = makeEngine(createFakeReaderWith(reader), { store }));
    await engine.start();
    await waitFor(() => store.listSessions().every((record) => record.state === 'complete'), 4_000);

    await engine.stop();
    await store.close();
  });

  it('stops automatic retries after the attempt cap and resets them on a forced reconcile', async () => {
    const { MAX_AUTOMATIC_ATTEMPTS } = await import('../../src/service/sync');
    const reader = createFakeReader({ failMessageReadsFor: { ses_cap: 1_000 } });
    reader.sessions.push(sessionRecord('ses_cap', 1));
    reader.messages.set('ses_cap', [assistantEvent('ses_cap')]);

    const store = await openStore();
    const { engine } = makeEngine(reader, { store, retryBaseDelayMs: 1, retryCapDelayMs: 2 });
    await engine.start();
    await waitFor(() => (store.getSession('ses_cap')?.attempts ?? 0) >= MAX_AUTOMATIC_ATTEMPTS, 4_000);
    await new Promise((resolve) => setTimeout(resolve, 60));

    const attempts = store.getSession('ses_cap')!.attempts;
    expect(attempts).toBe(MAX_AUTOMATIC_ATTEMPTS);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(store.getSession('ses_cap')!.attempts).toBe(attempts);

    await engine.reconcile();
    await waitFor(() => reader.requestLog.filter((entry) => entry.kind === 'messages').length > attempts, 2_000);

    await engine.stop();
    await store.close();
  });

  it('leaves no timers behind after stop()', async () => {
    vi.useFakeTimers();
    try {
      const reader = createFakeReader();
      reader.sessions.push(sessionRecord('ses_timers', 1));
      const store = await openStore();
      const { engine } = makeEngine(reader, { store, reconcileIntervalMs: 1_000 });
      await engine.start();
      await engine.stop();
      expect(vi.getTimerCount()).toBe(0);
      await store.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

function createFakeReaderWith(source: ReturnType<typeof createFakeReader>): ReturnType<typeof createFakeReader> {
  const reader = createFakeReader();
  reader.sessions.push(...source.sessions);
  for (const [id, events] of source.messages) {
    reader.messages.set(id, events);
  }
  return reader;
}
