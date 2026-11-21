import { describe, expect, it } from 'vitest';

import { createTpsMeter, type TpsMeter } from '../../src/service/tps';

/** Builds an SSE response whose body the test drives manually. */
function sseFetch(): { fetchImpl: typeof fetch; push(frame: string): void; end(): void } {
  const controller = new AbortController();
  let pushChunk: ((chunk: string) => void) | null = null;
  let endStream: (() => void) | null = null;

  const body = new ReadableStream<Uint8Array>({
    start(ctl) {
      pushChunk = (chunk) => ctl.enqueue(new TextEncoder().encode(chunk));
      endStream = () => {
        try {
          ctl.close();
        } catch {
          // Already closed by an abort during dispose.
        }
      };
      // Keep the stream open until the test ends it or the meter aborts.
      controller.signal.addEventListener('abort', () => ctl.close());
    },
  });

  const fetchImpl = (async (input: unknown, init?: { signal?: AbortSignal }) => {
    // Mirror the caller's abort into the stream.
    init?.signal?.addEventListener('abort', () => controller.abort(), { once: true });
    return new Response(body as unknown as ReadableStream<Uint8Array>, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }) as unknown as typeof fetch;

  return {
    fetchImpl,
    push: (frame) => pushChunk?.(frame),
    end: () => endStream?.(),
  };
}

function frame(type: string, data: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ type, data })}\n\n`;
}

/** The meter's SSE reader consumes pushed frames asynchronously. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

async function meter(): Promise<{ m: TpsMeter; sse: ReturnType<typeof sseFetch>; clock: { value: number } }> {
  const sse = sseFetch();
  const clock = { value: Date.now() };
  const m = createTpsMeter({ fetchImpl: sse.fetchImpl, now: () => clock.value });
  m.watch({ origin: 'http://127.0.0.1:9999', sessionId: 'ses_live' });
  // Let startStream's await fetch resolve.
  await new Promise((resolve) => setTimeout(resolve, 5));
  return { m, sse, clock };
}

describe('createTpsMeter', () => {
  it('rejects non-http origins', () => {
    const m = createTpsMeter();
    expect(() => m.watch({ origin: 'file:///etc', sessionId: null })).toThrow(/origin/);
    expect(() => m.watch({ origin: 'http://user:pass@host', sessionId: null })).toThrow(/origin/);
    m.dispose();
  });

  it('rejects metadata and link-local origins', () => {
    const m = createTpsMeter();
    expect(() => m.watch({ origin: 'http://169.254.169.254', sessionId: null })).toThrow(/origin/);
    expect(() => m.watch({ origin: 'http://[fe80::1]:3000', sessionId: null })).toThrow(/origin/);
    expect(() => m.watch({ origin: 'http://metadata.google.internal', sessionId: null })).toThrow(/origin/);
    m.dispose();
  });

  it('parses CRLF-delimited SSE frames', async () => {
    const { m, sse } = await meter();
    const crlf = frame('session.text.delta', { sessionID: 'ses_live', assistantMessageID: 'msg_1', ordinal: 0, delta: 'abc' }).replace(/\n/g, '\r\n');
    sse.push(crlf);
    await flush();
    expect(m.rate().chars).toBe(3);
    m.dispose();
    sse.end();
  });

  it('keeps the measurement when watch is repeated unchanged', async () => {
    const { m, sse } = await meter();
    sse.push(frame('session.text.delta', { sessionID: 'ses_live', assistantMessageID: 'msg_1', ordinal: 0, delta: 'abc' }));
    await flush();
    expect(m.watch({ origin: 'http://127.0.0.1:9999', sessionId: 'ses_live' })).toBe(false);
    expect(m.rate().chars).toBe(3);
    m.dispose();
    sse.end();
  });

  it('counts streamed deltas into a rolling window and estimates tok/s', async () => {
    const { m, sse } = await meter();

    sse.push(frame('session.execution.started', { sessionID: 'ses_live' }));
    sse.push(frame('session.text.delta', { sessionID: 'ses_live', assistantMessageID: 'msg_1', ordinal: 0, delta: 'x'.repeat(100) }));
    sse.push(frame('session.reasoning.delta', { sessionID: 'ses_live', assistantMessageID: 'msg_1', ordinal: 0, delta: 'y'.repeat(200) }));
    await flush();

    const rate = m.rate();
    expect(rate.connection).toBe('live');
    expect(rate.busy).toBe(true);
    expect(rate.active).toBe(true);
    expect(rate.chars).toBe(300);
    expect(rate.charsPerSecond).toBeCloseTo(60, 6);
    // Default calibration: 0.25 chars per token.
    expect(rate.tokensPerSecond).toBeCloseTo(15, 6);
    expect(rate.waiting).toBeNull();

    m.dispose();
    sse.end();
  });

  it('never counts another session', async () => {
    const { m, sse } = await meter();

    sse.push(frame('session.text.delta', { sessionID: 'ses_other', assistantMessageID: 'msg_x', ordinal: 0, delta: 'zzz' }));
    sse.push(frame('session.text.delta', { sessionID: 'ses_live', assistantMessageID: 'msg_1', ordinal: 0, delta: 'ok' }));
    await flush();

    expect(m.rate().chars).toBe(2);

    m.dispose();
    sse.end();
  });

  it('counts a part exactly once: deltas or the ended boundary, never both', async () => {
    const { m, sse } = await meter();

    sse.push(frame('session.text.delta', { sessionID: 'ses_live', assistantMessageID: 'msg_1', ordinal: 0, delta: 'abc' }));
    sse.push(frame('session.text.ended', { sessionID: 'ses_live', assistantMessageID: 'msg_1', ordinal: 0, text: 'abcdef' }));
    await flush();

    // Deltas mark the part as streamed: the ended boundary adds nothing.
    expect(m.rate().chars).toBe(3);

    // A part that only ever arrived as a full value is counted from the boundary.
    sse.push(frame('session.tool.input.ended', { sessionID: 'ses_live', assistantMessageID: 'msg_1', id: 'call_1', text: '{"x":1}' }));
    await flush();
    expect(m.rate().chars).toBe(10);

    m.dispose();
    sse.end();
  });

  it('calibrates chars-per-token from settled steps and tracks session usage', async () => {
    const { m, sse, clock } = await meter();
    clock.value += 0;

    sse.push(frame('session.text.delta', { sessionID: 'ses_live', assistantMessageID: 'msg_1', ordinal: 0, delta: 'x'.repeat(400) }));
    sse.push(frame('session.step.ended', { sessionID: 'ses_live', assistantMessageID: 'msg_1', tokens: { output: 80, reasoning: 20, cache: { read: 0, write: 0 } } }));
    sse.push(
      frame('session.usage.updated', {
        sessionID: 'ses_live',
        cost: 0.4,
        tokens: { input: 500, output: 80, reasoning: 20, cache: { read: 30, write: 5 } },
      }),
    );
    await flush();

    const rate = m.rate();
    // 400 chars / 100 real generated tokens = ratio 0.25; EMA weight 0.3 from
    // the 0.25 default keeps 0.25.
    expect(rate.charsPerToken).toBeCloseTo(0.25, 6);
    expect(rate.sessionUsage).toEqual({
      cost: 0.4,
      input: 500,
      output: 80,
      reasoning: 20,
      cacheRead: 30,
      cacheWrite: 5,
      generated: 100,
    });

    m.dispose();
    sse.end();
  });

  it('finalizes a turn with real token counts and streaming-time average', async () => {
    const { m, sse, clock } = await meter();

    sse.push(frame('session.execution.started', { sessionID: 'ses_live' }));
    await flush();
    clock.value += 500;
    sse.push(frame('session.text.started', { sessionID: 'ses_live', assistantMessageID: 'msg_1', ordinal: 0 }));
    await flush();
    clock.value += 2_000;
    sse.push(frame('session.text.delta', { sessionID: 'ses_live', assistantMessageID: 'msg_1', ordinal: 0, delta: 'x'.repeat(500) }));
    await flush();
    clock.value += 1_000;
    sse.push(frame('session.step.streamed', { sessionID: 'ses_live', assistantMessageID: 'msg_1' }));
    await flush();
    clock.value += 3_000;
    sse.push(frame('session.step.ended', { sessionID: 'ses_live', assistantMessageID: 'msg_1', tokens: { output: 100, reasoning: 0, cache: { read: 0, write: 0 } } }));
    await flush();
    sse.push(frame('session.execution.succeeded', { sessionID: 'ses_live' }));
    await flush();

    const rate = m.rate();
    expect(rate.busy).toBe(false);
    expect(rate.lastTurn).not.toBeNull();
    expect(rate.lastTurn?.source).toBe('tokens');
    expect(rate.lastTurn?.tokens).toBe(100);
    // One step: from first output (t+500) to step.streamed (t+3500) = 3s.
    expect(rate.lastTurn?.tokensPerSecond).toBeCloseTo(100 / 3, 1);
    expect(rate.lastTurn?.activeMs).toBe(3_000);
    // Wall time spans first output → last streamed output; no pauses here.
    expect(rate.lastTurn?.wallMs).toBe(3_000);
    expect(rate.lastTurn?.pausedMs).toBe(0);

    m.dispose();
    sse.end();
  });

  it('reports waiting states from permission and form events', async () => {
    const { m, sse } = await meter();

    sse.push(frame('permission.asked', { sessionID: 'ses_live', id: 'perm_1' }));
    await flush();
    expect(m.rate().waiting).toBe('permission');

    sse.push(frame('permission.replied', { sessionID: 'ses_live', requestID: 'perm_1' }));
    sse.push(frame('form.created', { sessionID: 'ses_live', form: { sessionID: 'ses_live', id: 'form_1' } }));
    await flush();
    expect(m.rate().waiting).toBe('question');

    sse.push(frame('form.replied', { sessionID: 'ses_live', id: 'form_1' }));
    await flush();
    expect(m.rate().waiting).toBeNull();

    m.dispose();
    sse.end();
  });

  it('reports a legacy question as a question, not a permission', async () => {
    const { m, sse } = await meter();

    sse.push(frame('question.asked', { sessionID: 'ses_live', id: 'q_1' }));
    await flush();
    expect(m.rate().waiting).toBe('question');

    sse.push(frame('question.replied', { sessionID: 'ses_live', requestID: 'q_1' }));
    await flush();
    expect(m.rate().waiting).toBeNull();

    m.dispose();
    sse.end();
  });

  it('unwraps proxied event envelopes and tracks diagnostics', async () => {
    const { m, sse } = await meter();

    sse.push(
      `data: ${JSON.stringify({
        payload: { type: 'session.text.delta', data: { sessionID: 'ses_live', assistantMessageID: 'msg_1', ordinal: 0, delta: 'hi' } },
        directory: '/repo/demo',
        eventId: 'evt_1',
      })}\n\n`,
    );
    await flush();

    const rate = m.rate();
    expect(rate.chars).toBe(2);
    expect(rate.eventsSeen).toBe(1);
    expect(rate.lastEventType).toBe('session.text.delta');

    m.dispose();
    sse.end();
  });

  it('handles a watch switch by resetting the measurement', async () => {
    const { m, sse } = await meter();

    sse.push(frame('session.text.delta', { sessionID: 'ses_live', assistantMessageID: 'msg_1', ordinal: 0, delta: 'abc' }));
    await flush();
    expect(m.rate().chars).toBe(3);

    const changed = m.watch({ origin: 'http://127.0.0.1:9999', sessionId: 'ses_next' });
    expect(changed).toBe(true);
    expect(m.rate().chars).toBe(0);
    expect(m.rate().sessionId).toBe('ses_next');

    const unchanged = m.watch({ origin: 'http://127.0.0.1:9999', sessionId: 'ses_next' });
    expect(unchanged).toBe(false);

    m.dispose();
    sse.end();
  });

  it('marks activity with a hold window after the last event', async () => {
    const sse = sseFetch();
    const clock = { value: Date.now() };
    const m = createTpsMeter({ fetchImpl: sse.fetchImpl, now: () => clock.value });
    m.watch({ origin: 'http://127.0.0.1:9999', sessionId: 'ses_live' });
    await flush();

    sse.push(frame('session.tool.input.delta', { sessionID: 'ses_live', assistantMessageID: 'msg_1', id: 'call_1', delta: 'z' }));
    sse.push(frame('session.step.streamed', { sessionID: 'ses_live', assistantMessageID: 'msg_1' }));
    await flush();

    expect(m.rate(clock.value).active).toBe(true);
    expect(m.rate(clock.value + 1_000).active).toBe(true);
    expect(m.rate(clock.value + 3_000).active).toBe(false);

    m.dispose();
    sse.end();
  });
});
