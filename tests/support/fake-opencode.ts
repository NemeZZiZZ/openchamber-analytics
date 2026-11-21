import { createServer, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';

export type RecordedRequest = {
  method: string;
  path: string;
  query: URLSearchParams;
  authorization?: string;
};

export type FakeOpenCode = {
  url: string;
  requests: readonly RecordedRequest[];
  /** Pushes one OpenCode SSE event to every connected stream. */
  broadcast(event: unknown): void;
  /** Ends every SSE stream (simulates upstream disconnect). */
  endStreams(): void;
  stop(): Promise<void>;
};

export type FakeOpenCodeOptions = {
  /** Raw OpenCode session records served by /api/session. */
  sessions?: unknown[];
  /** Raw message records served by /api/session/:id/message. */
  messagesBySession?: Record<string, unknown[]>;
  /** Page size used for both session and message pagination (default 100). */
  pageSize?: number;
  /** Path prefix → number of injected 500 responses before success. */
  failuresBeforeSuccess?: Record<string, number>;
  /** Index in the session list replaced by a malformed record. */
  malformedSessionAt?: number;
  /** Makes message cursor.next repeat the same cursor forever. */
  repeatMessageCursor?: boolean;
};

function offsetCursorQuery(query: URLSearchParams): number {
  const cursor = query.get('cursor');

  if (!cursor) {
    return 0;
  }

  const match = /^off-(\d+)$/.exec(cursor);
  return match ? Number(match[1]) : 0;
}

function paginate(
  items: unknown[],
  query: URLSearchParams,
  pageSize: number,
  repeatCursor: boolean,
): { data: unknown[]; cursor: { next?: string } } {
  const limitRaw = Number(query.get('limit') ?? pageSize);
  // The fake honors the requested limit but never exceeds its own page size,
  // so tests can force pagination with a small pageSize.
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), pageSize) : pageSize;
  const offset = offsetCursorQuery(query);
  const data = items.slice(offset, offset + limit);
  const hasMore = offset + data.length < items.length;

  let next: string | undefined;

  if (hasMore) {
    next = `off-${offset + data.length}`;
  } else if (repeatCursor && offset > 0) {
    // Self-referencing cursor: pagination must detect and fail, never loop.
    next = `off-${offset}`;
  }

  return { data, cursor: next === undefined ? {} : { next } };
}

/**
 * A minimal fake of the read-only OpenCode transport: only the allowlisted
 * GET routes plus an SSE /api/event stream. Records every request so tests
 * can assert page shapes, auth headers, and the absence of disallowed calls.
 */
export async function createFakeOpenCode(options: FakeOpenCodeOptions = {}): Promise<FakeOpenCode> {
  const requests: RecordedRequest[] = [];
  const failureCounters = new Map<string, number>();
  const sseClients = new Set<ServerResponse>();
  const pageSize = options.pageSize ?? 100;
  const sessions = [...(options.sessions ?? [])];
  const messagesBySession = options.messagesBySession ?? {};

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake.opencode');
    const record: RecordedRequest = {
      method: req.method ?? 'GET',
      path: url.pathname,
      query: url.searchParams,
      authorization: req.headers.authorization,
    };
    requests.push(record);

    for (const [prefix, allowedFailures] of Object.entries(options.failuresBeforeSuccess ?? {})) {
      if (url.pathname.startsWith(prefix)) {
        const seen = failureCounters.get(prefix) ?? 0;

        if (seen < allowedFailures) {
          failureCounters.set(prefix, seen + 1);
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ message: 'injected fake failure' }));
          return;
        }
      }
    }

    if ((req.method ?? 'GET') !== 'GET') {
      res.writeHead(405, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'method not allowed' }));
      return;
    }

    if (url.pathname === '/api/session') {
      const page = paginate(sessions, url.searchParams, pageSize, false);

      if (options.malformedSessionAt !== undefined) {
        const index = options.malformedSessionAt;
        const safeIndex = Math.min(Math.max(index, 0), Math.max(page.data.length - 1, 0));

        if (page.data.length > 0) {
          page.data[safeIndex] = { nonsense: true, id: 42 };
        }
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(page));
      return;
    }

    const sessionMatch = /^\/api\/session\/([^/]+)$/.exec(url.pathname);

    if (sessionMatch) {
      const sessionId = decodeURIComponent(sessionMatch[1] ?? '');
      const session = sessions.find((candidate) => (candidate as { id?: string }).id === sessionId);

      if (!session) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'session not found' }));
        return;
      }

      // The generated client unwraps a { data } envelope for single resources.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: session }));
      return;
    }

    const messagesMatch = /^\/api\/session\/([^/]+)\/message$/.exec(url.pathname);

    if (messagesMatch) {
      const sessionId = decodeURIComponent(messagesMatch[1] ?? '');
      const all = messagesBySession[sessionId] ?? [];
      const type = url.searchParams.get('type');
      const filtered = type ? all.filter((message) => (message as { type?: string }).type === type) : all;
      const page = paginate(filtered, url.searchParams, pageSize, options.repeatMessageCursor ?? false);

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(page));
      return;
    }

    if (url.pathname === '/api/event') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(':connected\n\n');
      sseClients.add(res);

      req.on('close', () => {
        sseClients.delete(res);
      });

      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'not found' }));
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  const endStreams = (): void => {
    for (const client of [...sseClients]) {
      client.end();
      sseClients.delete(client);
    }
  };

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    broadcast(event) {
      for (const client of sseClients) {
        client.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    },
    endStreams,
    async stop() {
      endStreams();
      server.close();
      await once(server, 'close');
    },
  };
}

/** Builds a realistic raw OpenCode session record. */
export function fakeSessionRaw(index: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `ses_${String(index).padStart(4, '0')}`,
    title: `Session ${index}`,
    agent: 'build',
    model: { id: 'glm-5', providerID: 'zai' },
    cost: 0.1 + index * 0.01,
    tokens: {
      input: 10 * index + 1,
      output: 5 * index + 1,
      reasoning: index,
      cache: { read: 2 * index, write: index },
    },
    location: { directory: '/repo/demo' },
    time: { created: 1_700_000_000_000 + index * 1_000, updated: 1_700_000_100_000 + index * 1_000 },
    ...overrides,
  };
}

/** Builds a realistic raw assistant message record with usage data. */
export function fakeAssistantMessageRaw(sessionId: string, index: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `msg_${sessionId}_${index}`,
    type: 'assistant',
    sessionID: sessionId,
    agent: 'build',
    model: { id: 'glm-5', providerID: 'zai' },
    cost: 0.05,
    tokens: { input: 4, output: 2, reasoning: 1, cache: { read: 1, write: 0 } },
    time: { created: 1_700_000_050_000 + index * 1_000 },
    ...overrides,
  };
}

/** Builds a raw user message record (must never be requested). */
export function fakeUserMessageRaw(sessionId: string, index: number): Record<string, unknown> {
  return {
    id: `msg_user_${sessionId}_${index}`,
    type: 'user',
    sessionID: sessionId,
    time: { created: 1_700_000_010_000 + index * 1_000 },
  };
}
