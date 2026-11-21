import { afterEach, describe, expect, it } from 'vitest';

import { createOpenCodeReader, MESSAGE_PAGE_LIMIT, SESSION_PAGE_LIMIT } from '../../src/service/opencode';
import {
  createFakeOpenCode,
  fakeAssistantMessageRaw,
  fakeSessionRaw,
  fakeUserMessageRaw,
  type FakeOpenCode,
} from '../support/fake-opencode';
import { totalTokens } from '../../src/shared/analytics-types';

const instances: FakeOpenCode[] = [];

async function fake(options: Parameters<typeof createFakeOpenCode>[0] = {}): Promise<FakeOpenCode> {
  const instance = await createFakeOpenCode(options);
  instances.push(instance);
  return instance;
}

afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.stop()));
});

const TOKEN = 'test-service-token';

function reader(fakeInstance: FakeOpenCode, fetchImpl?: typeof fetch) {
  return createOpenCodeReader({ baseUrl: fakeInstance.url, token: TOKEN, fetchImpl });
}

async function collect<T>(iterable: AsyncIterable<T>, signal?: AbortSignal): Promise<T[]> {
  const items: T[] = [];

  for await (const item of iterable) {
    items.push(item);

    if (signal?.aborted) {
      break;
    }
  }

  return items;
}

describe('createOpenCodeReader — sessions', () => {
  it('pages through sessions with limit=100, ascending order, cursor propagation, and bearer auth', async () => {
    const fakeInstance = await fake({ sessions: Array.from({ length: 250 }, (_, index) => fakeSessionRaw(index)) });
    const records = await collect(reader(fakeInstance).listSessions());

    expect(records).toHaveLength(250);
    expect(records[0]?.sessionId).toBe('ses_0000');

    const sessionRequests = fakeInstance.requests.filter((request) => request.path === '/api/session');
    expect(sessionRequests).toHaveLength(3);
    expect(sessionRequests[0]?.query.get('limit')).toBe('100');
    expect(sessionRequests[0]?.query.get('order')).toBe('asc');
    expect(sessionRequests[0]?.query.get('cursor')).toBeNull();
    expect(sessionRequests[1]?.query.get('cursor')).toBe('off-100');
    expect(sessionRequests[2]?.query.get('cursor')).toBe('off-200');

    for (const request of fakeInstance.requests) {
      expect(request.authorization).toBe(`Bearer ${TOKEN}`);
    }
  });

  it('uses the shared page limit constants', () => {
    expect(SESSION_PAGE_LIMIT).toBe(100);
    // Message pages must stay well below the ~8 MB transport cap.
    expect(MESSAGE_PAGE_LIMIT).toBe(20);
  });

  it('yields nothing for an empty session list without looping', async () => {
    const fakeInstance = await fake({ sessions: [] });
    const records = await collect(reader(fakeInstance).listSessions());

    expect(records).toEqual([]);
    expect(fakeInstance.requests.filter((request) => request.path === '/api/session')).toHaveLength(1);
  });

  it('fails retryably on injected 500 responses', async () => {
    const fakeInstance = await fake({
      sessions: [fakeSessionRaw(0)],
      failuresBeforeSuccess: { '/api/session': 1 },
    });

    let firstError: unknown;

    try {
      for await (const _ of reader(fakeInstance).listSessions()) {
        void _;
      }
    } catch (error) {
      firstError = error;
    }

    expect((firstError as { name?: string }).name).toBe('OpenCodeReaderError');
    expect((firstError as { retryable?: boolean }).retryable).toBe(true);

    // A retry starts a fresh iterator; it succeeds once the injected failure
    // is exhausted (the sync engine owns this retry loop).
    const records = await collect(reader(fakeInstance).listSessions());
    expect(records).toHaveLength(1);
    expect(fakeInstance.requests.filter((request) => request.path === '/api/session')).toHaveLength(2);
  });

  it('fails retryably when fetch throws', async () => {
    const fakeInstance = await fake({ sessions: [fakeSessionRaw(0)] });
    const failing = reader(fakeInstance, () => {
      throw new Error('network down');
    });

    await expect(async () => {
      for await (const _ of failing.listSessions()) {
        void _;
      }
    }).rejects.toMatchObject({ name: 'OpenCodeReaderError', retryable: true });
  });

  it('skips malformed session records instead of failing the whole list', async () => {
    const fakeInstance = await fake({
      sessions: [fakeSessionRaw(0), fakeSessionRaw(1), fakeSessionRaw(2)],
      malformedSessionAt: 1,
    });
    const skipped: number[] = [];
    const seen: string[] = [];

    for await (const record of createOpenCodeReader({
      baseUrl: fakeInstance.url,
      token: TOKEN,
      onSkippedSessions: (count) => skipped.push(count),
    }).listSessions()) {
      seen.push(record.sessionId);
    }

    expect(seen).toHaveLength(2);
    expect(skipped).toEqual([1]);
  });

  it('stops retryable when pagination repeats a cursor instead of looping forever', async () => {
    const fakeInstance = await fake({ sessions: Array.from({ length: 40 }, (_, index) => fakeSessionRaw(index)) });

    const seen: unknown[] = [];
    let cursorRepetition: unknown;

    // Simulate a hostile server by intercepting fetch: rewrite every response
    // cursor.next to the same value.
    const looping = createOpenCodeReader({
      baseUrl: fakeInstance.url,
      token: TOKEN,
      fetchImpl: async (input, init) => {
        const response = await fetch(input, init);

        if (String(input).includes('/api/session?') || String(input).endsWith('/api/session')) {
          const body = await response.json() as { cursor?: { next?: string } };
          body.cursor = { next: 'off-100' };
          return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
        }

        return response;
      },
    });

    try {
      for await (const record of looping.listSessions()) {
        seen.push(record);

        if (seen.length > 500) {
          throw new Error('pagination looped forever');
        }
      }
    } catch (error) {
      cursorRepetition = error;
    }

    expect(seen.length).toBeLessThanOrEqual(200);
    expect((cursorRepetition as { retryable?: boolean }).retryable).toBe(true);
  });

  it('fetches a single session and returns null for missing ones', async () => {
    const fakeInstance = await fake({ sessions: [fakeSessionRaw(7)] });
    const readerInstance = reader(fakeInstance);

    const found = await readerInstance.getSession('ses_0007');
    expect(found?.sessionId).toBe('ses_0007');
    expect(found?.title).toBe('Session 7');

    const missing = await readerInstance.getSession('ses_absent');
    expect(missing).toBeNull();
  });
});

describe('createOpenCodeReader — messages', () => {
  it('requests assistant-only cursor pages without the order parameter', async () => {
    // The OpenCode message route rejects cursor + order combinations
    // ("Cursor cannot be combined with order"), so ordering must never be
    // sent — pagination relies on the server's default order instead.
    const messages = [
      fakeUserMessageRaw('ses_msg', 0),
      fakeAssistantMessageRaw('ses_msg', 0),
      fakeAssistantMessageRaw('ses_msg', 1),
    ];
    const fakeInstance = await fake({
      sessions: [fakeSessionRaw(0, { id: 'ses_msg' })],
      messagesBySession: { ses_msg: messages },
      pageSize: 1,
    });

    const session = (await reader(fakeInstance).getSession('ses_msg'))!;
    const raw = await collect(reader(fakeInstance).listAssistantMessages(session));

    expect(raw).toHaveLength(2);
    expect((raw[0] as { id: string }).id).toBe('msg_ses_msg_0');
    expect((raw[1] as { id: string }).id).toBe('msg_ses_msg_1');

    const messageRequests = fakeInstance.requests.filter((request) => request.path === '/api/session/ses_msg/message');
    expect(messageRequests).toHaveLength(2);
    expect(messageRequests[0]?.query.get('type')).toBe('assistant');
    expect(messageRequests[0]?.query.get('limit')).toBe('20');
    expect(messageRequests[0]?.query.get('order')).toBeNull();
    expect(messageRequests[1]?.query.get('cursor')).toBe('off-1');
    expect(messageRequests[1]?.query.get('order')).toBeNull();
  });

  it('halves the page size when the transport truncates an oversized page', async () => {
    // The OpenChamber transport cuts response bodies near its ~8 MB cap; the
    // reader must shrink the page and re-request the same cursor instead of
    // failing the whole session.
    const messages = [
      fakeUserMessageRaw('ses_big', 0),
      ...Array.from({ length: 7 }, (_, index) => fakeAssistantMessageRaw('ses_big', index)),
    ];
    const fakeInstance = await fake({
      sessions: [fakeSessionRaw(0, { id: 'ses_big' })],
      messagesBySession: { ses_big: messages },
      pageSize: 7,
    });

    const blockingFetch: typeof fetch = (input, init) => {
      const limit = new URL(String(input)).searchParams.get('limit');
      if (limit !== null && Number(limit) >= 8) {
        return Promise.reject(new TypeError('terminated'));
      }

      return fetch(input, init);
    };

    const session = (await reader(fakeInstance).getSession('ses_big'))!;
    const raw = await collect(reader(fakeInstance, blockingFetch).listAssistantMessages(session));

    expect(raw).toHaveLength(7);
    // The 20- and 10-message attempts were rejected before reaching the
    // server (the fetch throws), so only the halved 5-message pages land.
    const sizes = fakeInstance.requests
      .filter((request) => request.path === '/api/session/ses_big/message')
      .map((request) => Number(request.query.get('limit')));
    expect(sizes).toEqual([5, 5]);
  });

  it('yields nothing for an empty assistant history', async () => {
    const fakeInstance = await fake({
      sessions: [fakeSessionRaw(0, { id: 'ses_empty' })],
      messagesBySession: { ses_empty: [fakeUserMessageRaw('ses_empty', 0)] },
    });

    const session = (await reader(fakeInstance).getSession('ses_empty'))!;
    const raw = await collect(reader(fakeInstance).listAssistantMessages(session));

    expect(raw).toEqual([]);
    expect(fakeInstance.requests.filter((request) => request.path.includes('/message'))).toHaveLength(1);
  });

  it('fails retryably when a message cursor repeats forever', async () => {
    const fakeInstance = await fake({
      sessions: [fakeSessionRaw(0, { id: 'ses_loop' })],
      messagesBySession: {
        ses_loop: Array.from({ length: 5 }, (_, index) => fakeAssistantMessageRaw('ses_loop', index)),
      },
      pageSize: 2,
      repeatMessageCursor: true,
    });

    const session = (await reader(fakeInstance).getSession('ses_loop'))!;

    await expect(async () => {
      let count = 0;

      for await (const _ of reader(fakeInstance).listAssistantMessages(session)) {
        count += 1;

        if (count > 100) {
          throw new Error('message pagination looped forever');
        }
      }
    }).rejects.toMatchObject({ retryable: true, message: expect.stringContaining('repeated') });
  });

  it('passes raw message records through for incremental normalization', async () => {
    const fakeInstance = await fake({
      sessions: [fakeSessionRaw(0, { id: 'ses_raw' })],
      messagesBySession: {
        ses_raw: [
          fakeAssistantMessageRaw('ses_raw', 0, { parts: [{ type: 'text', text: 'raw body that must never be stored' }] }),
        ],
      },
    });

    const session = (await reader(fakeInstance).getSession('ses_raw'))!;
    const raw = await collect(reader(fakeInstance).listAssistantMessages(session));

    expect((raw[0] as { tokens?: unknown }).tokens).toBeDefined();
    // The reader is transport-only: it does not strip or transform payloads.
    expect((raw[0] as { parts?: unknown }).parts).toBeDefined();
  });
});

describe('createOpenCodeReader — events', () => {
  it('maps session.usage.updated to a total-snapshot stream event', async () => {
    const fakeInstance = await fake({ sessions: [] });
    const readerInstance = reader(fakeInstance);

    const eventsPromise = (async () => {
      const events: unknown[] = [];

      for await (const event of readerInstance.streamEvents()) {
        events.push(event);

        if (events.length >= 1) {
          break;
        }
      }

      return events;
    })();

    // Give the SSE connection a moment to establish, then broadcast.
    await new Promise((resolve) => setTimeout(resolve, 100));
    fakeInstance.broadcast({
      type: 'session.usage.updated',
      data: {
        sessionID: 'ses_live',
        cost: 1.25,
        tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 1 } },
      },
    });

    const events = await Promise.race([
      eventsPromise,
      new Promise((resolve) => setTimeout(() => resolve(null), 2_000)),
    ]) as unknown[] | null;

    expect(events).not.toBeNull();
    const event = events?.[0] as {
      type: string;
      sessionID: string;
      cost: number;
      tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } };
    };

    expect(event.type).toBe('session.usage.updated');
    expect(event.sessionID).toBe('ses_live');
    expect(event.cost).toBeCloseTo(1.25, 9);
    expect(totalTokens(event.tokens)).toBe(21);
  });

  it('ignores unrelated event types and ends when the stream closes', async () => {
    const fakeInstance = await fake({ sessions: [] });
    const readerInstance = reader(fakeInstance);

    const collection = collect(readerInstance.streamEvents());
    await new Promise((resolve) => setTimeout(resolve, 100));

    fakeInstance.broadcast({ type: 'session.status', data: { sessionID: 'x' } });
    fakeInstance.broadcast({ type: 'session.created', data: { info: {} } });

    // Closing the stream must end the async iterator.
    setTimeout(() => fakeInstance.endStreams(), 100);
    const events = await collection;

    expect(events).toEqual([]);
  });

  it('yields session.deleted events after deletion reconciliation', async () => {
    const fakeInstance = await fake({ sessions: [] });
    const readerInstance = reader(fakeInstance);

    const eventsPromise = (async () => {
      const events: unknown[] = [];

      for await (const event of readerInstance.streamEvents()) {
        events.push(event);

        if (events.length >= 1) {
          break;
        }
      }

      return events;
    })();

    await new Promise((resolve) => setTimeout(resolve, 100));
    fakeInstance.broadcast({ type: 'session.deleted', data: { sessionID: 'ses_gone' } });

    const events = await Promise.race([
      eventsPromise,
      new Promise((resolve) => setTimeout(() => resolve(null), 2_000)),
    ]) as unknown[] | null;

    expect((events?.[0] as { type?: string })?.type).toBe('session.deleted');
    expect((events?.[0] as { sessionID?: string })?.sessionID).toBe('ses_gone');
  });
});

describe('allowlist discipline', () => {
  it('never issues writes, Stats, or provider calls', async () => {
    const fakeInstance = await fake({
      sessions: Array.from({ length: 5 }, (_, index) => fakeSessionRaw(index, { id: `ses_ok_${index}` })),
      messagesBySession: Object.fromEntries(
        Array.from({ length: 5 }, (_, index) => [`ses_ok_${index}`, [fakeAssistantMessageRaw(`ses_ok_${index}`, 0)]]),
      ),
    });

    const readerInstance = reader(fakeInstance);
    await collect(readerInstance.listSessions());

    for (let index = 0; index < 5; index += 1) {
      const session = (await readerInstance.getSession(`ses_ok_${index}`))!;
      await collect(readerInstance.listAssistantMessages(session));
    }

    const disallowed = fakeInstance.requests.filter(
      (request) =>
        request.method !== 'GET' ||
        request.path.includes('stats') ||
        request.path.includes('provider') ||
        !request.path.startsWith('/api/'),
    );

    expect(disallowed).toEqual([]);
    expect(new Set(fakeInstance.requests.map((request) => request.path))).toEqual(
      new Set(['/api/session', ...fakeInstance.requests.filter((r) => /\/api\/session\/.+/.test(r.path)).map((r) => r.path)]),
    );
  });
});

describe('createOpenCodeReader — not found detection', () => {
  it('does not treat connection errors or ids containing 404 as a missing session', async () => {
    const failing = createOpenCodeReader({
      baseUrl: 'http://127.0.0.1:54040',
      token: TOKEN,
      fetchImpl: (async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:54040');
      }) as unknown as typeof fetch,
    });

    await expect(failing.getSession('ses_404x')).rejects.toThrow();
  });
});
