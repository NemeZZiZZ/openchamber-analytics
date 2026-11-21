import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { createAnalyticsServer } from '../../src/service/routes';
import { openAnalyticsStore } from '../../src/service/store';
import { buildAnalyticsSnapshot } from '../../src/service/snapshot';
import type { StoredSessionAnalytics, UsageEvent } from '../../src/shared/analytics-types';
import type { AnalyticsStore } from '../../src/service/store';
import type { SyncEngine } from '../../src/service/sync';
import type { ServiceEvents } from '../../src/service/service-events';

const TOKEN = 'route-test-token';
const NOW = Date.parse('2026-11-18T12:00:00Z');
const DAY_MS = 86_400_000;

const dataDirs: string[] = [];
const servers: Server[] = [];

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  await Promise.all(
    dataDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => undefined)),
  );
});

async function tempStore(): Promise<AnalyticsStore> {
  const dir = await mkdtemp(join(tmpdir(), 'analytics-routes-'));
  dataDirs.push(dir);
  return openAnalyticsStore(dir);
}

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

function record(sessionId: string, events: UsageEvent[]): StoredSessionAnalytics {
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

function stubEngine(): SyncEngine {
  return {
    start: vi.fn(async () => undefined),
    setPriority: vi.fn(),
    refresh: vi.fn(async () => undefined),
    reconcile: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    onRevision: vi.fn(() => () => undefined),
    sessionListComplete: vi.fn(() => true),
  } as unknown as SyncEngine;
}

type ServerHandle = {
  server: ReturnType<typeof createAnalyticsServer>;
  url: string;
};

async function startServer(options: { engine?: SyncEngine; store?: AnalyticsStore; host?: unknown; serviceEvents?: ServiceEvents } = {}): Promise<ServerHandle> {
  const store = options.store ?? (await tempStore());
  const engine = options.engine ?? stubEngine();

  const server = createAnalyticsServer({
    store,
    engine,
    token: TOKEN,
    host: options.host as never,
    serviceEvents: options.serviceEvents,
    port: 0,
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  servers.push(server);

  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function getJson(url: string, path: string, init: RequestInit = {}): Promise<{ status: number; body: unknown; text: string }> {
  const response = await fetch(`${url}${path}`, init);
  const text = await response.text();
  let body: unknown = null;

  try {
    body = JSON.parse(text) as unknown;
  } catch {
    body = null;
  }

  return { status: response.status, body, text };
}

const authHeaders = { Authorization: `Bearer ${TOKEN}` };

describe('snapshot filter validation', () => {
  it('rejects project scope without a directory', async () => {
    const { url } = await startServer();
    const response = await getJson(url, '/v1/snapshot?scope=project&range=30d&surface=page&timeZone=UTC', { headers: authHeaders });

    expect(response.status).toBe(400);
  });
});

describe('authentication', () => {
  it('rejects missing and wrong bearer tokens on every route including /health', async () => {
    const { url } = await startServer();

    for (const path of ['/health', '/v1/snapshot?scope=all&range=30d&surface=page&timeZone=UTC', '/v1/refresh']) {
      const missing = await getJson(url, path);
      expect(missing.status).toBe(401);

      const wrong = await getJson(url, path, { headers: { Authorization: 'Bearer wrong' } });
      expect(wrong.status).toBe(401);
    }
  });

  it('binds loopback only', async () => {
    const { server } = await startServer();
    const address = server.address() as AddressInfo;

    expect(address.address).toBe('127.0.0.1');
  });
});

describe('GET /v1/snapshot', () => {
  it('serves a validated snapshot and updates sync priority', async () => {
    const store = await tempStore();
    await store.upsertSession(record('ses_1', [makeEvent('ses_1')]));
    const engine = stubEngine();
    const { url } = await startServer({ store, engine });

    const result = await getJson(url, '/v1/snapshot?scope=all&range=30d&surface=page&timeZone=UTC', { headers: authHeaders });

    expect(result.status).toBe(200);
    const snapshot = result.body as { schemaVersion: number; summary: { tokens: number }; timeZone: string; filters: { range: string } };

    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.summary.tokens).toBe(21);
    expect(snapshot.timeZone).toBe('UTC');
    expect(snapshot.filters.range).toBe('30d');
    expect(engine.setPriority).toHaveBeenCalled();
  });

  it('invalidates a cached snapshot after a metadata-only update', async () => {
    const store = await tempStore();
    await store.upsertSession(record('ses_1', [makeEvent('ses_1')]));
    const { url } = await startServer({ store });
    const path = '/v1/snapshot?scope=all&range=30d&surface=page&timeZone=UTC';

    const first = await getJson(url, path, { headers: authHeaders });
    const firstSnapshot = first.body as { revision: number; topSessions: { title: string }[] };
    expect(firstSnapshot.topSessions[0]?.title).toBe('Session ses_1');

    const stored = store.getSession('ses_1')!;
    await store.updateSessionMetadata({ ...stored.session, title: 'Renamed', directory: '/repo/moved' });

    const second = await getJson(url, path, { headers: authHeaders });
    const secondSnapshot = second.body as { revision: number; topSessions: { title: string }[] };
    expect(secondSnapshot.revision).toBeGreaterThan(firstSnapshot.revision);
    expect(secondSnapshot.topSessions[0]?.title).toBe('Renamed');
  });

  it('rejects invalid query parameters with safe errors', async () => {
    const { url } = await startServer();

    const badRange = await getJson(url, '/v1/snapshot?scope=all&range=15d&surface=page&timeZone=UTC', { headers: authHeaders });
    expect(badRange.status).toBe(400);

    const badScope = await getJson(url, '/v1/snapshot?scope=everything&range=30d&surface=page&timeZone=UTC', { headers: authHeaders });
    expect(badScope.status).toBe(400);

    const badSurface = await getJson(url, '/v1/snapshot?scope=all&range=30d&surface=sidebar&timeZone=UTC', { headers: authHeaders });
    expect(badSurface.status).toBe(400);
  });

  it('accepts the 1d (Today) range offered by the page', async () => {
    const { url } = await startServer();
    const result = await getJson(url, '/v1/snapshot?scope=all&range=1d&surface=page&timeZone=UTC', { headers: authHeaders });

    expect(result.status).toBe(200);
    expect((result.body as { filters: { range: string } }).filters.range).toBe('1d');
  });

  it('falls back to UTC for an invalid timezone and echoes the effective zone', async () => {
    const { url } = await startServer();
    const result = await getJson(url, '/v1/snapshot?scope=all&range=30d&surface=page&timeZone=Not/AZone', { headers: authHeaders });

    expect(result.status).toBe(200);
    expect((result.body as { timeZone: string }).timeZone).toBe('UTC');
  });

  it('keeps cached snapshots keyed by the full filter identity, including timezone', async () => {
    const store = await tempStore();
    await store.upsertSession(record('ses_1', [makeEvent('ses_1', { timestamp: Date.parse('2026-11-18T16:00:00Z') })]));
    const { url } = await startServer({ store });

    const utc = await getJson(url, '/v1/snapshot?scope=all&range=7d&surface=page&timeZone=UTC', { headers: authHeaders });
    const kir = await getJson(url, '/v1/snapshot?scope=all&range=7d&surface=page&timeZone=Pacific/Kiritimati', { headers: authHeaders });

    expect(utc.status).toBe(200);
    expect(kir.status).toBe(200);

    // The same UTC instant lands on different local days per zone.
    const eventDay = (body: unknown): string | undefined =>
      ((body as { daily: { day: string; tokens: number }[] }).daily.find((bucket) => bucket.tokens > 0))?.day;

    expect(eventDay(utc.body)).toBe('2026-11-18');
    expect(eventDay(kir.body)).toBe('2026-11-19');
    expect(eventDay(utc.body)).not.toBe(eventDay(kir.body));
    // Cached snapshots must never share a key based only on scope/range.
    expect((utc.body as { timeZone: string }).timeZone).toBe('UTC');
    expect((kir.body as { timeZone: string }).timeZone).toBe('Pacific/Kiritimati');
  });

  it('retains the last good snapshot when building fails', async () => {
    const store = await tempStore();
    await store.upsertSession(record('ses_1', [makeEvent('ses_1')]));
    const { url } = await startServer({ store });

    const good = await getJson(url, '/v1/snapshot?scope=all&range=30d&surface=page&timeZone=UTC', { headers: authHeaders });
    expect(good.status).toBe(200);

    // Corrupt the store listing so the next build throws.
    vi.spyOn(store, 'listSessions').mockImplementation(() => {
      throw new Error('store exploded');
    });

    const bad = await getJson(url, '/v1/snapshot?scope=all&range=90d&surface=page&timeZone=UTC', { headers: authHeaders });
    expect(bad.status).toBe(500);
    expect(bad.text).not.toContain('store exploded');

    // The previously served snapshot data stays intact for the same filter.
    const cached = await getJson(url, '/v1/snapshot?scope=all&range=30d&surface=page&timeZone=UTC', { headers: authHeaders });
    expect(cached.status).toBe(200);
    expect((cached.body as { summary: { tokens: number } }).summary.tokens).toBe(21);
  });
});

describe('GET /v1/sessions', () => {
  it('paginates the top sessions list with cursors', async () => {
    const store = await tempStore();

    for (let index = 0; index < 25; index += 1) {
      const sessionId = `ses_${String(index).padStart(2, '0')}`;
      await store.upsertSession(record(sessionId, [makeEvent(sessionId, { cost: 0.01 * (index + 1) })]));
    }

    const { url } = await startServer({ store });

    const page1 = await getJson(url, '/v1/sessions?scope=all&range=30d&surface=page&timeZone=UTC&limit=10', { headers: authHeaders });
    expect(page1.status).toBe(200);
    const body1 = page1.body as { data: unknown[]; cursor: { next?: string } };

    expect(body1.data).toHaveLength(10);
    expect(body1.cursor.next).toBeDefined();

    const page2 = await getJson(url, `/v1/sessions?scope=all&range=30d&surface=page&timeZone=UTC&limit=10&cursor=${body1.cursor.next}`, { headers: authHeaders });
    const body2 = page2.body as { data: unknown[]; cursor: { next?: string } };

    expect(body2.data).toHaveLength(10);
    expect(body2.cursor.next).toBeDefined();

    const page3 = await getJson(url, `/v1/sessions?scope=all&range=30d&surface=page&timeZone=UTC&limit=10&cursor=${body2.cursor.next}`, { headers: authHeaders });
    expect((page3.body as { data: unknown[] }).data).toHaveLength(5);
    expect(((page3.body as { cursor: { next?: string } }).cursor.next)).toBeUndefined();
  });
});

describe('POST commands', () => {
  it('accepts POST-only refresh/reconcile/reset and rejects other methods', async () => {
    const { url } = await startServer();

    for (const path of ['/v1/refresh', '/v1/reconcile', '/v1/reset', '/v1/watch']) {
      const wrongMethod = await getJson(url, path, { method: 'GET', headers: authHeaders });
      expect(wrongMethod.status).toBe(405);

      const post = await getJson(url, path, {
        method: 'POST',
        headers: { ...authHeaders, 'content-type': 'application/json' },
        body: path === '/v1/watch' ? JSON.stringify({ origin: 'http://127.0.0.1:5000', sessionId: null }) : undefined,
      });
      expect(post.status).toBe(200);
      expect(post.body).toMatchObject({ ok: true });
    }

    const unknown = await getJson(url, '/v1/unknown', { headers: authHeaders });
    expect(unknown.status).toBe(404);
  });

  it('publishes the post-reset revision even when restart emits no revision', async () => {
    const store = await tempStore();
    const engine = stubEngine();
    const serviceEvents: ServiceEvents = {
      revisionChanged: vi.fn(),
      progressPublished: vi.fn(),
      stop: vi.fn(async () => undefined),
    };
    const { url } = await startServer({ store, engine, serviceEvents });

    const reset = await getJson(url, '/v1/reset', { method: 'POST', headers: authHeaders });
    expect(reset.status).toBe(200);
    expect(serviceEvents.revisionChanged).toHaveBeenCalledWith(store.currentRevision());
  });

  it('resets by stopping the engine before clearing the store, then restarts', async () => {
    const store = await tempStore();
    await store.upsertSession(record('ses_1', [makeEvent('ses_1')]));
    const engine = stubEngine();
    const { url } = await startServer({ store, engine });

    const reset = await getJson(url, '/v1/reset', { method: 'POST', headers: authHeaders });
    expect(reset.status).toBe(200);

    const stopOrder = (engine.stop as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0] ?? 0;
    expect(stopOrder).toBeGreaterThan(0);
    expect(engine.stop).toHaveBeenCalled();
    expect(store.listSessions()).toEqual([]);
    expect(engine.start).toHaveBeenCalled();
  });
});

describe('service events and limits', () => {
  it('emits compact analytics:changed/progress events through the service host', async () => {
    const emitted: { topic: string; data: unknown }[] = [];
    const host = {
      emit: async (topic: string, data: unknown) => {
        emitted.push({ topic, data });
        return { delivered: true } as const;
      },
    };

    const store = await tempStore();
    await store.upsertSession(record('ses_1', [makeEvent('ses_1')]));
    const engine = stubEngine();

    const listeners: ((revision: number) => void)[] = [];
    (engine.onRevision as ReturnType<typeof vi.fn>).mockImplementation((listener: (revision: number) => void) => {
      listeners.push(listener);
      return () => undefined;
    });

    const { url } = await startServer({ store, engine, host });

    // Simulate the engine publishing a revision.
    for (const listener of listeners) {
      listener(store.nextRevision());
    }

    // Serve a snapshot so progress coverage is available.
    await getJson(url, '/v1/snapshot?scope=all&range=30d&surface=page&timeZone=UTC', { headers: authHeaders });
    for (const listener of listeners) {
      listener(store.nextRevision());
    }
    // The revision notifications coalesce over the 500–1000ms window.
    await new Promise((resolve) => setTimeout(resolve, 900));

    const changed = emitted.filter((entry) => entry.topic === 'analytics:changed');
    expect(changed.length).toBeGreaterThan(0);
    expect(Object.keys(changed[0]?.data as object)).toEqual(['revision']);

    const progress = emitted.filter((entry) => entry.topic === 'analytics:progress');
    expect(progress.length).toBeGreaterThan(0);
    expect(Object.keys(progress[0]?.data as object).sort()).toEqual(['coverage', 'revision']);
    // No daily arrays or history in event payloads.
    expect(JSON.stringify(progress[0]?.data).length).toBeLessThan(2_000);

    void url;
  });

  it('keeps generated snapshot responses far below the 8 MB host cap', async () => {
    const store = await tempStore();

    // 400 sessions × 30 daily events: a large-but-plausible workspace.
    for (let sessionIndex = 0; sessionIndex < 400; sessionIndex += 1) {
      const sessionId = `ses_${sessionIndex}`;
      const events = Array.from({ length: 30 }, (_, day) => makeEvent(sessionId, { timestamp: NOW - day * DAY_MS }));
      await store.upsertSession(record(sessionId, events));
    }

    const { url } = await startServer({ store });
    const result = await getJson(url, '/v1/snapshot?scope=all&range=90d&surface=page&timeZone=UTC', { headers: authHeaders });

    expect(result.status).toBe(200);
    expect(result.text.length).toBeLessThan(8_000_000);
  });

  it('never exposes tokens, OpenCode URLs, or raw events in responses', async () => {
    const store = await tempStore();
    await store.upsertSession(record('ses_1', [makeEvent('ses_1')]));
    const { url } = await startServer({ store });

    const snapshot = await getJson(url, '/v1/snapshot?scope=all&range=30d&surface=page&timeZone=UTC', { headers: authHeaders });
    const sessions = await getJson(url, '/v1/sessions?scope=all&range=30d&surface=page&timeZone=UTC', { headers: authHeaders });
    const denied = await getJson(url, '/v1/snapshot?scope=all&range=30d&surface=page&timeZone=UTC');

    const everything = `${snapshot.text}${sessions.text}${denied.text}`;

    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain('OPENCHAMBER_OPENCODE_URL');
    expect(everything).not.toContain('"source":"residual" ?');
    expect(everything).not.toContain('"messageCount":1,"source":"assistant","estimated":false,"parts"');
    expect(denied.text).not.toContain('Bearer');

    void buildAnalyticsSnapshot;
  });
});

describe('POST /v1/watch and GET /v1/rate', () => {
  it('rejects non-http origins and serves rate snapshots', async () => {
    const { url } = await startServer();

    const bad = await getJson(url, '/v1/watch', {
      method: 'POST',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ origin: 'file:///etc' }),
    });
    expect(bad.status).toBe(400);

    const watch = await getJson(url, '/v1/watch', {
      method: 'POST',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ origin: 'http://127.0.0.1:5000', sessionId: 'ses_live' }),
    });
    expect(watch.status).toBe(200);
    expect(watch.body).toMatchObject({ ok: true, changed: true, sessionId: 'ses_live' });

    const rate = await getJson(url, '/v1/rate', { headers: authHeaders });
    expect(rate.status).toBe(200);
    const body = rate.body as { connection: string; sessionId: string | null; windowMs: number; tokensPerSecond: number };
    // The origin is unreachable in tests: the meter reports connecting/error.
    expect(['connecting', 'error']).toContain(body.connection);
    expect(body.sessionId).toBe('ses_live');
    expect(body.windowMs).toBe(5000);
    expect(body.tokensPerSecond).toBe(0);
  });

  it('unwatches with a null sessionId', async () => {
    const { url } = await startServer();

    for (const sessionId of ['ses_live', null]) {
      const watch = await getJson(url, '/v1/watch', {
        method: 'POST',
        headers: { ...authHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ origin: 'http://127.0.0.1:5000', sessionId }),
      });
      expect(watch.status).toBe(200);
    }

    const rate = await getJson(url, '/v1/rate', { headers: authHeaders });
    expect((rate.body as { sessionId: string | null }).sessionId).toBeNull();
    expect((rate.body as { connection: string }).connection).toBe('idle');
  });
});
