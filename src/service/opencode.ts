import { OpenCode } from '@opencode/client';

import type { CounterKind, SessionRecord, TokenUsage } from '../shared/analytics-types';
import { normalizeSession } from './normalize';

/**
 * Bounded, read-only adapter over the OpenCode transport. Only the documented
 * allowlisted GET routes are exercised: session lists, single sessions,
 * assistant-only message pages, and the SSE event stream. The generated
 * client responses are always validated at runtime — generated types are not
 * a guarantee that every optional field is populated.
 */

export const SESSION_PAGE_LIMIT = 100;
/**
 * Assistant messages carry their full content, so a page can weigh megabytes
 * and the OpenChamber transport caps responses near 8 MB — a 100-message page
 * gets its connection terminated mid-body. 20 messages keeps pages ~1 MB.
 */
export const MESSAGE_PAGE_LIMIT = 20;
/** Hard guard against endless or repeated-cursor pagination. */
const MAX_PAGES = 10_000;

export class OpenCodeReaderError extends Error {
  readonly retryable: boolean;

  constructor(message: string, options: { retryable?: boolean; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = 'OpenCodeReaderError';
    this.retryable = options.retryable ?? true;
  }
}

export type OpenCodeStreamEvent =
  | {
      /**
       * A total session-level usage snapshot; never a delta to sum. `cost` or
       * `tokens` is null when the payload omitted it: such an event is only a
       * hint that the session changed, never a zeroing snapshot.
       */
      type: 'session.usage.updated';
      sessionID: string;
      cost: number | null;
      tokens: TokenUsage | null;
    }
  | { type: 'session.deleted'; sessionID: string }
  | {
      /** A counted stream occurrence; the payload itself is discarded. */
      type: 'counter';
      kind: CounterKind;
      sessionID: string;
      timestamp: number;
      /** Permission id on permissionAsked/permissionReplied for wait pairing. */
      permissionID?: string;
    };

export type OpenCodeReader = {
  listSessions(signal?: AbortSignal): AsyncIterable<SessionRecord>;
  listAssistantMessages(session: SessionRecord, signal?: AbortSignal): AsyncIterable<unknown>;
  streamEvents(signal?: AbortSignal): AsyncIterable<OpenCodeStreamEvent>;
  getSession(sessionId: string, signal?: AbortSignal): Promise<SessionRecord | null>;
};

export type OpenCodeReaderOptions = {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  /** Called once per session list scan that dropped unreadable records. */
  onSkippedSessions?: (count: number) => void;
};

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function normalizeTokens(value: unknown): TokenUsage {
  const raw = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const cache = typeof raw.cache === 'object' && raw.cache !== null ? (raw.cache as Record<string, unknown>) : {};

  return {
    input: finiteNumber(raw.input),
    output: finiteNumber(raw.output),
    reasoning: finiteNumber(raw.reasoning),
    cache: {
      read: finiteNumber(cache.read),
      write: finiteNumber(cache.write),
    },
  };
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const reason = (error as { reason?: unknown }).reason;
    return typeof reason === 'string' ? `${reason} — ${error.message}` : error.message;
  }

  return String(error);
}

/** True when a fetch failed because the response body was cut mid-transfer. */
function isTruncatedResponse(error: unknown): boolean {
  return describeError(error).includes('terminated');
}

/**
 * Not-found detection. Structured signals first (tagged `*NotFoundError`, HTTP
 * 404 status); the generated client also throws plain errors that carry only
 * the server message, so a word-bounded text fallback remains. A port such as
 * `54040` or an id such as `ses_404x` never matches.
 */
function isNotFound(error: unknown): boolean {
  if (typeof error === 'object' && error !== null) {
    const candidate = error as { _tag?: unknown; name?: unknown; status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
    const tag = typeof candidate._tag === 'string' ? candidate._tag : typeof candidate.name === 'string' ? candidate.name : '';

    if (
      /NotFoundError$/.test(tag) ||
      candidate.status === 404 ||
      candidate.statusCode === 404 ||
      candidate.response?.status === 404
    ) {
      return true;
    }
  }

  const description = error instanceof Error ? `${(error as { reason?: unknown }).reason ?? ''} ${error.message}` : String(error);
  return /(?<![\w.:-])404(?![\w.:-])|\bnot found\b/i.test(description) && !/ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed/i.test(description);
}

function defaultSkippedSessions(count: number): void {
  console.error(`[analytics] skipped ${count} unreadable session record(s) in the session list`);
}

export function createOpenCodeReader(options: OpenCodeReaderOptions): OpenCodeReader {
  const authorizedFetch: typeof fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${options.token}`);
    return (options.fetchImpl ?? fetch)(input, { ...init, headers });
  };

  const client = OpenCode.make({
    baseUrl: options.baseUrl,
    fetch: authorizedFetch,
    headers: { Authorization: `Bearer ${options.token}` },
  });

  function wrapError(context: string, error: unknown): OpenCodeReaderError {
    if (error instanceof OpenCodeReaderError) {
      return error;
    }

    return new OpenCodeReaderError(`${context}: ${describeError(error)}`, { cause: error });
  }

  function cursorGuard(seen: Set<string>, next: string, context: string): void {
    if (seen.has(next)) {
      throw new OpenCodeReaderError(`${context} pagination repeated a cursor; refusing to loop`);
    }

    seen.add(next);
  }

  async function* listSessions(signal?: AbortSignal): AsyncIterable<SessionRecord> {
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    let skipped = 0;

    try {
      for (let page = 0; page < MAX_PAGES; page += 1) {
        let response: { data?: unknown[]; cursor?: { next?: string | null } };

        try {
          const raw = await client.session.list(
            { limit: SESSION_PAGE_LIMIT, order: 'asc', cursor },
            { signal },
          );
          response = raw as unknown as typeof response;
        } catch (error) {
          throw wrapError('session list failed', error);
        }

        for (const item of response.data ?? []) {
          const record = normalizeSession(item);

          if (!record) {
            // One unreadable record must not block every other session forever.
            skipped += 1;
            continue;
          }

          yield record;
        }

        const next = response.cursor?.next ?? null;

        if (!next) {
          return;
        }

        cursorGuard(seenCursors, next, 'session');
        cursor = next;
      }

      throw new OpenCodeReaderError('session pagination exceeded the page guard; retryable');
    } finally {
      if (skipped > 0) {
        (options.onSkippedSessions ?? defaultSkippedSessions)(skipped);
      }
    }
  }

  async function* listAssistantMessages(session: SessionRecord, signal?: AbortSignal): AsyncIterable<unknown> {
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    let pageSize = MESSAGE_PAGE_LIMIT;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      let response: { data?: unknown[]; cursor?: { next?: string | null } };

      try {
        // The message route rejects cursor + order combinations, so pages
        // rely on the server's default ordering; cursor pagination alone
        // keeps every page consistent.
        const raw = await client.message.list(
          {
            sessionID: session.sessionId,
            limit: pageSize,
            type: 'assistant',
            cursor,
          },
          { signal },
        );
        response = raw as unknown as typeof response;
      } catch (error) {
        // The transport truncates oversized response bodies near its ~8 MB
        // cap, and message pages can exceed it even at modest limits. Halve
        // the page and re-request the same cursor until it fits.
        if (pageSize > 1 && isTruncatedResponse(error)) {
          pageSize = Math.max(1, Math.floor(pageSize / 2));
          continue;
        }

        throw wrapError(`assistant messages failed for ${session.sessionId}`, error);
      }

      // Raw assistant records pass through; normalization and payload
      // stripping happen incrementally in the reconciliation layer.
      for (const item of response.data ?? []) {
        yield item;
      }

      pageSize = MESSAGE_PAGE_LIMIT;
      const next = response.cursor?.next ?? null;

      if (!next) {
        return;
      }

      cursorGuard(seenCursors, next, 'message');
      cursor = next;
    }

    throw new OpenCodeReaderError('message pagination exceeded the page guard; retryable');
  }

  /** Wire event types worth counting, mapped to their counter kind. */
  const COUNTER_EVENT_TYPES: Record<string, CounterKind> = {
    'session.execution.failed': 'executionFailed',
    'session.execution.interrupted': 'executionInterrupted',
    'session.compaction.started': 'compaction',
    'session.retry.scheduled': 'retryScheduled',
    'permission.asked': 'permissionAsked',
    'permission.replied': 'permissionReplied',
  };

  function asCounterEvent(wire: { type?: string; created?: number; data?: Record<string, unknown> }): OpenCodeStreamEvent | null {
    const kind = wire.type === undefined ? undefined : COUNTER_EVENT_TYPES[wire.type];

    if (kind === undefined) {
      return null;
    }

    const sessionID = typeof wire.data?.sessionID === 'string' ? wire.data.sessionID : '';
    const created = wire.created;
    const timestamp = typeof created === 'number' && Number.isFinite(created) ? created : null;

    if (sessionID === '' || timestamp === null) {
      return null;
    }

    const permissionIDRaw =
      kind === 'permissionAsked' ? wire.data?.id : kind === 'permissionReplied' ? wire.data?.requestID : undefined;
    const permissionID = typeof permissionIDRaw === 'string' && permissionIDRaw !== '' ? permissionIDRaw : undefined;

    return permissionID === undefined
      ? { type: 'counter', kind, sessionID, timestamp }
      : { type: 'counter', kind, sessionID, timestamp, permissionID };
  }

  async function* streamEvents(signal?: AbortSignal): AsyncIterable<OpenCodeStreamEvent> {
    const events = client.event.subscribe({ signal });

    for await (const event of events) {
      const wire = event as { type?: string; created?: number; data?: Record<string, unknown> };

      if (wire.type === 'session.usage.updated') {
        yield {
          type: 'session.usage.updated',
          sessionID: typeof wire.data?.sessionID === 'string' ? wire.data.sessionID : '',
          cost: typeof wire.data?.cost === 'number' && Number.isFinite(wire.data.cost) ? finiteNumber(wire.data.cost) : null,
          tokens: typeof wire.data?.tokens === 'object' && wire.data.tokens !== null ? normalizeTokens(wire.data.tokens) : null,
        };
      } else if (wire.type === 'session.deleted') {
        yield {
          type: 'session.deleted',
          sessionID: typeof wire.data?.sessionID === 'string' ? wire.data.sessionID : '',
        };
      } else {
        const counter = asCounterEvent(wire);

        if (counter) {
          yield counter;
        }
      }

      // Unrelated event content is ignored.
    }
  }

  async function getSession(sessionId: string, signal?: AbortSignal): Promise<SessionRecord | null> {
    let raw: unknown;

    try {
      raw = await client.session.get({ sessionID: sessionId }, { signal });
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }

      throw wrapError(`session get failed for ${sessionId}`, error);
    }

    const record = normalizeSession(raw);

    if (!record) {
      // Not a deletion: an unreadable record must never be confirmed as gone.
      throw new OpenCodeReaderError(`session get returned a malformed record for ${sessionId}; retryable`);
    }

    return record;
  }

  return {
    listSessions,
    listAssistantMessages,
    streamEvents,
    getSession,
  };
}
