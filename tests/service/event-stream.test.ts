import { describe, expect, it } from 'vitest';

import { createEventStream, defaultReconnectBackoffMs } from '../../src/service/event-stream';
import type { OpenCodeReader, OpenCodeStreamEvent } from '../../src/service/opencode';

type ControlledStream = {
  push(event: OpenCodeStreamEvent): void;
  end(): void;
  fail(error: Error): void;
};

/** A reader whose SSE stream is driven manually by the test. */
function controlledReader(): { reader: Pick<OpenCodeReader, 'streamEvents'>; control: ControlledStream } {
  const queue: OpenCodeStreamEvent[] = [];
  let ended = false;
  let failure: Error | null = null;
  let notify: (() => void) | null = null;

  const wake = (): void => {
    const current = notify;
    notify = null;
    current?.();
  };

  const reader = {
    async *streamEvents(signal?: AbortSignal): AsyncIterable<OpenCodeStreamEvent> {
      while (true) {
        if (signal?.aborted) {
          return;
        }

        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }

        if (failure) {
          throw failure;
        }

        if (ended) {
          return;
        }

        // Wait for the next item, an abort, or a stream end — whichever first.
        await Promise.race([
          new Promise<void>((resolve) => {
            notify = resolve;
          }),
          new Promise<void>((resolve) => {
            signal?.addEventListener('abort', () => resolve(), { once: true });
          }),
        ]);
      }
    },
  };

  const control: ControlledStream = {
    push(event) {
      queue.push(event);
      wake();
    },
    end() {
      ended = true;
      wake();
    },
    fail(error) {
      failure = error;
      ended = true;
      wake();
    },
  };

  return { reader, control };
}

function fakeTimers() {
  const scheduled: { id: number; at: number; callback: () => void }[] = [];
  let now = 0;
  let nextId = 1;

  const setTimeout = (callback: () => void, ms: number): unknown => {
    const id = nextId++;
    scheduled.push({ id, at: now + ms, callback });
    return id;
  };

  const clearTimeout = (id: unknown): void => {
    const index = scheduled.findIndex((entry) => entry.id === id);

    if (index >= 0) {
      scheduled.splice(index, 1);
    }
  };

  const advance = async (ms: number): Promise<void> => {
    const target = now + ms;

    for (;;) {
      const next = scheduled.filter((entry) => entry.at <= target).sort((a, b) => a.at - b.at)[0];

      if (!next) {
        break;
      }

      now = next.at;
      clearTimeout(next.id);
      next.callback();
      await Promise.resolve();
    }

    now = target;
  };

  return { timers: { setTimeout, clearTimeout }, advance, pending: () => scheduled.length };
}

/** Yields control to pending microtasks so the stream loop can progress. */
async function settle(times = 4): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
}

describe('defaultReconnectBackoffMs', () => {
  it('starts at 1s and doubles up to the 60s cap', () => {
    expect(defaultReconnectBackoffMs(0)).toBe(1_000);
    expect(defaultReconnectBackoffMs(1)).toBe(2_000);
    expect(defaultReconnectBackoffMs(2)).toBe(4_000);
    expect(defaultReconnectBackoffMs(5)).toBe(32_000);
    expect(defaultReconnectBackoffMs(6)).toBe(60_000);
    expect(defaultReconnectBackoffMs(20)).toBe(60_000);
  });
});

describe('createEventStream', () => {
  it('delivers mapped events to the handler', async () => {
    const { reader, control } = controlledReader();
    const received: OpenCodeStreamEvent[] = [];
    const { timers } = fakeTimers();

    const stream = createEventStream({
      reader,
      onEvent: (event) => received.push(event),
      onDisconnect: () => undefined,
      timers,
    });

    stream.start();
    await settle();

    control.push({ type: 'session.deleted', sessionID: 'ses_x' });
    await settle();

    expect(received).toEqual([{ type: 'session.deleted', sessionID: 'ses_x' }]);

    await stream.stop();
  });

  it('reconnects with 1s→2s backoff after the stream ends and reports disconnect', async () => {
    const { reader, control } = controlledReader();
    const disconnects: number[] = [];
    const fake = fakeTimers();
    let connections = 0;

    const stream = createEventStream({
      reader: {
        streamEvents: async function* (signal?: AbortSignal) {
          connections += 1;
          yield* reader.streamEvents(signal);
        },
      },
      onEvent: () => undefined,
      onDisconnect: () => disconnects.push(connections),
      timers: fake.timers,
    });

    stream.start();
    await settle();
    expect(connections).toBe(1);

    control.end();
    await settle();

    expect(disconnects).toEqual([1]);
    expect(fake.pending()).toBe(1);

    await fake.advance(1_000);
    await settle();
    expect(connections).toBe(2);

    control.end();
    await settle();
    await fake.advance(2_000);
    await settle();

    expect(connections).toBe(3);

    await stream.stop();
  });

  it('stops reconnecting after stop() and leaves no pending timers', async () => {
    const { reader, control } = controlledReader();
    const fake = fakeTimers();

    const stream = createEventStream({
      reader,
      onEvent: () => undefined,
      onDisconnect: () => undefined,
      timers: fake.timers,
    });

    stream.start();
    await settle();

    control.end();
    await settle();

    expect(fake.pending()).toBe(1);

    await stream.stop();
    expect(fake.pending()).toBe(0);

    // Advancing later must not reconnect.
    await fake.advance(120_000);
    await settle();
    expect(fake.pending()).toBe(0);
  });

  it('treats reader failures as disconnects and reconnects', async () => {
    const { reader, control } = controlledReader();
    const fake = fakeTimers();
    let disconnects = 0;

    const stream = createEventStream({
      reader,
      onEvent: () => undefined,
      onDisconnect: () => {
        disconnects += 1;
      },
      timers: fake.timers,
    });

    stream.start();
    await settle();

    control.fail(new Error('upstream gone'));
    await settle();

    expect(disconnects).toBe(1);
    expect(fake.pending()).toBe(1);

    await stream.stop();
  });
});
