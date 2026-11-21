import { createServiceHost, type ServiceHost } from '@openchamber/sdk';

import type { Coverage } from '../shared/analytics-types';

/** Compact change/progress notifications (spec §8.7): no history, no chart arrays. */
export type AnalyticsChangedEvent = { topic: 'analytics:changed'; data: { revision: number } };
export type AnalyticsProgressEvent = { topic: 'analytics:progress'; data: { revision: number; coverage: Coverage } };

export type ServiceEventsOptions = {
  /** Injectable host; defaults to the SDK service host over the process env. */
  host?: ServiceHost;
  env?: Record<string, string | undefined>;
  /** Revision notification coalescing window (500–1000ms per spec). */
  coalesceMs?: number;
  timers?: {
    setTimeout: (callback: () => void, ms: number) => unknown;
    clearTimeout: (id: unknown) => void;
  };
};

export type ServiceEvents = {
  /** Publishes analytics:changed for the newest revision, coalescing bursts. */
  revisionChanged(revision: number): void;
  /** Publishes analytics:progress with the latest known coverage. */
  progressPublished(revision: number, coverage: Coverage): void;
  stop(): Promise<void>;
};

const DEFAULT_COALESCE_MS = 750;

/**
 * Host event publisher for the analytics service. Bursts of revisions
 * coalesce into a single compact `analytics:changed` notification; progress
 * events carry only the revision and coverage counters.
 */
export function createServiceEvents(options: ServiceEventsOptions = {}): ServiceEvents {
  const host: ServiceHost = options.host ?? createServiceHost({ env: options.env ?? process.env });
  const coalesceMs = options.coalesceMs ?? DEFAULT_COALESCE_MS;
  const timers = options.timers;

  let pendingRevision: number | null = null;
  let pendingTimer: unknown = null;
  let latestCoverage: Coverage | null = null;
  let latestProgressRevision = 0;
  let stopped = false;

  function schedule(callback: () => void, ms: number): unknown {
    if (timers) {
      return timers.setTimeout(callback, ms);
    }

    return setTimeout(callback, ms);
  }

  function cancel(handle: unknown): void {
    if (timers) {
      timers.clearTimeout(handle);
    } else {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    }
  }

  async function emitSafely(topic: string, data: unknown): Promise<void> {
    if (stopped) {
      return;
    }

    try {
      await host.emit(topic, data as never);
    } catch {
      // The host may be restarting; notifications are at-most-once hints and
      // every newly mounted surface fetches the current snapshot anyway.
    }
  }

  return {
    revisionChanged(revision) {
      pendingRevision = Math.max(pendingRevision ?? 0, revision);

      if (pendingTimer !== null) {
        return;
      }

      pendingTimer = schedule(() => {
        pendingTimer = null;
        const next = pendingRevision;
        pendingRevision = null;

        if (next !== null) {
          void emitSafely('analytics:changed', { revision: next });

          if (latestCoverage && next > latestProgressRevision) {
            latestProgressRevision = next;
            void emitSafely('analytics:progress', { revision: next, coverage: latestCoverage });
          }
        }
      }, coalesceMs);
    },

    progressPublished(revision, coverage) {
      latestCoverage = coverage;

      if (revision <= latestProgressRevision) {
        return;
      }

      latestProgressRevision = revision;
      void emitSafely('analytics:progress', { revision, coverage });
    },

    async stop() {
      stopped = true;

      if (pendingTimer !== null) {
        cancel(pendingTimer);
        pendingTimer = null;
      }
    },
  };
}
