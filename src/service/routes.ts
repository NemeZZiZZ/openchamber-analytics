import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { AnalyticsStore } from './store';
import { buildAnalyticsSnapshot, scopeRecords, snapshotCacheKey } from './snapshot';
import { earliestKnownActivity } from './coverage';
import { rankTopSessions, TOP_SESSIONS_LIMIT } from './aggregate-models';
import { createPeriodWindow, resolveTimeZone } from './time';
import type { AnalyticsFilters, AnalyticsRange, AnalyticsScope, AnalyticsSurface, Coverage, TopSession } from '../shared/analytics-types';
import type { SyncEngine } from './sync';
import { createServiceEvents, type ServiceEvents } from './service-events';
import { createTpsMeter, type TpsMeter } from './tps';
import type { ServiceHost } from '@openchamber/sdk';

const MAX_BODY_BYTES = 4_096;
const SESSIONS_PAGE_LIMIT = 100;
const HOST_RESPONSE_CAP = 8_000_000;

export type AnalyticsServerOptions = {
  store: AnalyticsStore;
  engine: SyncEngine;
  token: string;
  host?: ServiceHost;
  port?: number;
  /** Injectable service-events publisher; defaults are created internally. */
  serviceEvents?: ServiceEvents;
  /** Injectable TPS meter; defaults are created internally. */
  tps?: TpsMeter;
};

type CacheEntry = {
  revision: number;
  snapshot: unknown;
  /** The snapshot serialized once; cache hits are sent without re-stringifying. */
  payload: string;
};

type RouteResult = {
  status: number;
  body: unknown;
  /** Pre-serialized JSON for `body`, when already available. */
  payload?: string;
};

const RANKING_CACHE_LIMIT = 8;
const RANGES: AnalyticsRange[] = ['1d', '7d', '30d', '90d', 'all'];
const SCOPES: AnalyticsScope[] = ['all', 'project'];
const SURFACES: AnalyticsSurface[] = ['page', 'panel'];

function sendJson(response: ServerResponse, status: number, body: unknown, serialized?: string): void {
  const payload = serialized ?? JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  response.end(payload);
}

function sendError(response: ServerResponse, status: number, message: string): void {
  // Safe error DTO: no internals, no underlying error details.
  sendJson(response, status, { error: message });
}

function readBody(request: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];

    request.on('data', (chunk: Buffer) => {
      size += chunk.length;

      if (size > MAX_BODY_BYTES) {
        resolve(null);
        request.destroy();
        return;
      }

      chunks.push(chunk);
    });

    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', () => resolve(null));
  });
}

function isAuthorized(authorization: string, token: string): boolean {
  const actual = createHash('sha256').update(authorization).digest();
  const expected = createHash('sha256').update(`Bearer ${token}`).digest();
  return timingSafeEqual(actual, expected);
}

function firstQueryValue(query: URLSearchParams, key: string): string | undefined {
  const value = query.get(key);
  return value === null || value === '' ? undefined : value;
}

function parseFilters(query: URLSearchParams): { filters?: AnalyticsFilters; error?: string } {
  const scope = (firstQueryValue(query, 'scope') ?? 'all') as AnalyticsScope;
  const range = (firstQueryValue(query, 'range') ?? '30d') as AnalyticsRange;
  const surface = (firstQueryValue(query, 'surface') ?? 'page') as AnalyticsSurface;
  const directory = firstQueryValue(query, 'directory');
  const timeZone = resolveTimeZone(firstQueryValue(query, 'timeZone'));

  if (!SCOPES.includes(scope)) {
    return { error: 'invalid scope' };
  }

  if (!RANGES.includes(range)) {
    return { error: 'invalid range' };
  }

  if (!SURFACES.includes(surface)) {
    return { error: 'invalid surface' };
  }

  if (scope === 'project' && directory === undefined) {
    return { error: 'directory is required for project scope' };
  }

  return {
    filters: {
      scope,
      range,
      surface,
      timeZone,
      directory,
    },
  };
}

/**
 * The authenticated analytics HTTP API. Every route — including /health —
 * requires the host-provided service bearer token, and the server listens
 * only on 127.0.0.1. Snapshots are cached per full filter identity (scope,
 * directory, range, surface, effective timezone) and invalidated by revision,
 * so two viewers in different timezones never share a cached aggregate.
 */
export function createAnalyticsServer(options: AnalyticsServerOptions): Server {
  const { store, engine, token } = options;
  const cache = new Map<string, CacheEntry>();
  const serviceEvents = options.serviceEvents ?? createServiceEvents({ host: options.host });
  const tps = options.tps ?? createTpsMeter();

  engine.onRevision((revision) => {
    serviceEvents.revisionChanged(revision);
  });

  function buildSnapshot(
    filters: AnalyticsFilters,
    now: number,
  ): { snapshot: unknown; coverage: Coverage; payload: string } {
    const key = snapshotCacheKey(filters, now);
    const revision = store.currentRevision();
    const cached = cache.get(key);

    if (cached && cached.revision === revision) {
      // Refresh recency so the cache evicts least-recently-used entries.
      cache.delete(key);
      cache.set(key, cached);
      return {
        snapshot: cached.snapshot,
        coverage: (cached.snapshot as { coverage: Coverage }).coverage,
        payload: cached.payload,
      };
    }

    const records = store.listSessions();

    const snapshot = buildAnalyticsSnapshot({
      filters,
      revision,
      now,
      records,
      counters: store.listCounters(),
      sessionListComplete: engine.sessionListComplete(),
    });

    const payload = JSON.stringify(snapshot);

    if (Buffer.byteLength(payload) > HOST_RESPONSE_CAP) {
      throw new Error('snapshot exceeds the host response cap');
    }

    cache.set(key, { revision, snapshot, payload });

    // Keep the cache bounded.
    if (cache.size > 32) {
      const firstKey = cache.keys().next().value;

      if (firstKey !== undefined) {
        cache.delete(firstKey);
      }
    }

    return { snapshot, coverage: snapshot.coverage, payload };
  }

  function handleSnapshot(query: URLSearchParams, now: number): RouteResult {
    const { filters, error } = parseFilters(query);

    if (!filters || error) {
      return { status: 400, body: { error: error ?? 'invalid filters' } };
    }

    // The visible selection drives sync priority.
    engine.setPriority(filters);

    try {
      const { snapshot, coverage, payload } = buildSnapshot(filters, now);
      serviceEvents.progressPublished(store.currentRevision(), coverage);
      return { status: 200, body: snapshot, payload };
    } catch {
      return { status: 500, body: { error: 'snapshot unavailable' } };
    }
  }

  const rankingCache = new Map<string, TopSession[]>();

  function handleSessions(query: URLSearchParams, now: number): RouteResult {
    const { filters, error } = parseFilters(query);

    if (!filters || error) {
      return { status: 400, body: { error: error ?? 'invalid filters' } };
    }

    const limitRaw = Number(firstQueryValue(query, 'limit') ?? 20);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.floor(limitRaw), 1), SESSIONS_PAGE_LIMIT) : 20;
    const cursorRaw = Number(firstQueryValue(query, 'cursor') ?? 0);
    const offset = Number.isFinite(cursorRaw) && cursorRaw > 0 ? Math.floor(cursorRaw) : 0;

    try {
      const revision = store.currentRevision();
      const rankingKey = `${revision}|${snapshotCacheKey(filters, now)}`;
      let all = rankingCache.get(rankingKey);

      if (all) {
        rankingCache.delete(rankingKey);
      } else {
        const records = scopeRecords(store.listSessions(), filters);
        const window = createPeriodWindow(filters.range, now, filters.timeZone, earliestKnownActivity(records));
        all = rankTopSessions(
          records.flatMap((record) => record.events),
          records.map((record) => record.session),
          window,
          filters.timeZone,
          Number.MAX_SAFE_INTEGER,
        );
      }

      // Pages of one revision share a single ranking so cursors stay stable.
      rankingCache.set(rankingKey, all);

      while (rankingCache.size > RANKING_CACHE_LIMIT) {
        const oldest = rankingCache.keys().next().value;

        if (oldest === undefined) {
          break;
        }

        rankingCache.delete(oldest);
      }

      const data = all.slice(offset, offset + limit);
      const nextCursor = offset + limit < all.length ? String(offset + limit) : undefined;

      return {
        status: 200,
        body: {
          data,
          cursor: nextCursor === undefined ? {} : { next: nextCursor },
          revision: store.currentRevision(),
        },
      };
    } catch {
      return { status: 500, body: { error: 'session list unavailable' } };
    }
  }

  // Commands mutate the store/engine: run them one at a time.
  let commandChain: Promise<unknown> = Promise.resolve();

  function handleCommand(path: string): Promise<RouteResult> {
    const run = commandChain.then(() => runCommand(path));
    commandChain = run.catch(() => undefined);
    return run;
  }

  async function runCommand(path: string): Promise<RouteResult> {
    if (path === '/v1/refresh') {
      await engine.refresh();
      return { status: 200, body: { ok: true, revision: store.currentRevision() } };
    }

    if (path === '/v1/reconcile') {
      await engine.reconcile();
      return { status: 200, body: { ok: true, revision: store.currentRevision() } };
    }

    if (path !== '/v1/reset') {
      return { status: 404, body: { error: 'not found' } };
    }

    // /v1/reset: invalidate in-flight sync generations first (engine.stop
    // aborts workers), clear the store, then start a fresh bootstrap so a
    // late worker cannot reinsert pre-reset records.
    await engine.stop();
    await store.reset();
    cache.clear();
    await engine.start();
    serviceEvents.revisionChanged(store.currentRevision());

    return { status: 200, body: { ok: true, revision: store.currentRevision() } };
  }

  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const path = url.pathname;
      const method = (request.method ?? 'GET').toUpperCase();

      if (!isAuthorized(request.headers.authorization ?? '', token)) {
        sendError(response, 401, 'unauthorized');
        return;
      }

      if (path === '/health' && method === 'GET') {
        sendJson(response, 200, { ok: true, revision: store.currentRevision() });
        return;
      }

      if (!path.startsWith('/v1/')) {
        sendError(response, 404, 'not found');
        return;
      }

      const isCommand = path === '/v1/refresh' || path === '/v1/reconcile' || path === '/v1/reset' || path === '/v1/watch';

      if (isCommand) {
        if (method !== 'POST') {
          sendError(response, 405, 'method not allowed');
          return;
        }

        const body = await readBody(request);

        if (body === null) {
          sendError(response, 413, 'payload too large');
          return;
        }

        if (path === '/v1/watch') {
          // TPS metering: the panel watches the open session; the origin must
          // be the OpenChamber server the panel is served from.
          try {
            const parsed = JSON.parse(body || '{}') as { origin?: unknown; sessionId?: unknown };
            const origin = typeof parsed.origin === 'string' ? parsed.origin : '';
            const sessionId = typeof parsed.sessionId === 'string' && parsed.sessionId.trim() !== '' ? parsed.sessionId : null;
            const changed = tps.watch({ origin, sessionId });
            sendJson(response, 200, { ok: true, changed, sessionId });
          } catch (error) {
            sendError(response, 400, error instanceof Error ? error.message : 'invalid watch request');
          }

          return;
        }

        try {
          const result = await handleCommand(path);
          sendJson(response, result.status, result.body);
        } catch {
          sendError(response, 500, 'command failed');
        }

        return;
      }

      if (method !== 'GET') {
        sendError(response, 405, 'method not allowed');
        return;
      }

      if (path === '/v1/snapshot') {
        const result = handleSnapshot(url.searchParams, Date.now());
        sendJson(response, result.status, result.body, result.payload);
        return;
      }

      if (path === '/v1/sessions') {
        const result = handleSessions(url.searchParams, Date.now());
        sendJson(response, result.status, result.body);
        return;
      }

      if (path === '/v1/rate') {
        sendJson(response, 200, tps.rate());
        return;
      }

      sendError(response, 404, 'not found');
    })().catch(() => {
      if (!response.headersSent) {
        sendError(response, 500, 'internal error');
      }
    });
  });

  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 64;

  server.on('clientError', (_error, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  server.on('error', (error) => {
    console.error(`[analytics] http server error: ${error.message}`);
  });

  const port = options.port ?? 0;
  server.listen(port, '127.0.0.1');

  return server;
}

export { TOP_SESSIONS_LIMIT };
