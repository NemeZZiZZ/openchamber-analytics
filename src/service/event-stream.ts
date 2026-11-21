import type { OpenCodeReader, OpenCodeStreamEvent } from './opencode';

export type StreamTimers = {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
};

const globalTimers: StreamTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

/** Reconnect backoff: 1s doubling up to a hard 60s cap. */
export function defaultReconnectBackoffMs(attempt: number): number {
  const base = 1_000 * 2 ** Math.max(0, attempt);
  return Math.min(base, 60_000);
}

export type EventStreamHandle = {
  start(): void;
  stop(): Promise<void>;
};

export type EventStreamOptions = {
  reader: Pick<OpenCodeReader, 'streamEvents'>;
  onEvent: (event: OpenCodeStreamEvent) => void;
  /** Called when the stream ends or fails; upstream identity is unknown, so the owner must reconcile. */
  onDisconnect: () => void;
  timers?: StreamTimers;
  backoffMs?: (attempt: number) => number;
};

/**
 * Supervises the OpenCode event stream. Stream events are hints with no
 * replay guarantee: every disconnect triggers the owner's reconciliation on
 * the next reconnect instead of assuming one continuous upstream.
 */
export function createEventStream(options: EventStreamOptions): EventStreamHandle {
  const timers = options.timers ?? globalTimers;
  const backoffMs = options.backoffMs ?? defaultReconnectBackoffMs;

  const controller = new AbortController();
  let stopped = false;
  let reconnectTimer: unknown = null;
  let runPromise: Promise<void> = Promise.resolve();

  async function run(): Promise<void> {
    let attempt = 0;

    while (!stopped) {
      try {
        for await (const event of options.reader.streamEvents(controller.signal)) {
          if (stopped) {
            return;
          }

          attempt = 0;
          options.onEvent(event);
        }
      } catch {
        if (stopped || controller.signal.aborted) {
          return;
        }
      }

      if (stopped || controller.signal.aborted) {
        return;
      }

      options.onDisconnect();

      const delay = backoffMs(attempt);
      attempt += 1;

      // The reconnect delay is abortable: stop() must always unblock run().
      await new Promise<void>((resolve) => {
        const onAbort = (): void => {
          resolve();
        };

        controller.signal.addEventListener('abort', onAbort, { once: true });
        reconnectTimer = timers.setTimeout(() => {
          reconnectTimer = null;
          controller.signal.removeEventListener('abort', onAbort);
          resolve();
        }, delay);
      });
    }
  }

  return {
    start() {
      if (stopped) {
        throw new Error('event stream already stopped');
      }

      runPromise = run();
    },

    async stop() {
      stopped = true;

      if (reconnectTimer !== null) {
        timers.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }

      controller.abort();
      await runPromise.catch(() => undefined);
    },
  };
}
