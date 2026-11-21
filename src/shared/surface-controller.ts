import type { AnalyticsFilters, AnalyticsSnapshot, AnalyticsSurface } from './analytics-types';
import { resolveTimeZone } from './timezone';
import { snapshotRequest, type HostBridge, type HostReadyContext } from './host';

export type SurfaceStatus = 'idle' | 'loading' | 'ready' | 'refreshing' | 'error';

export type SurfaceState = {
  filters: AnalyticsFilters;
  /** The explicitly pinned project directory, if any; never a follow identity. */
  pinnedDirectory?: string;
  directory: string | null;
  status: SurfaceStatus;
  snapshot: AnalyticsSnapshot | null;
};

export type SurfaceControllerOptions = {
  bridge: HostBridge;
  surface: AnalyticsSurface;
  preferences?: Partial<AnalyticsFilters>;
  timeZone?: () => string;
  /** Injectable focus source; defaults to window focus in the browser. */
  focusSource?: (listener: () => void) => () => void;
  /** Service-event burst debounce; 0 disables the timer path. */
  eventDebounceMs?: number;
  /** First retry delay while no snapshot exists yet; 0 disables auto-retry. */
  retryBaseMs?: number;
};

const RETRY_CAP_MS = 30_000;
const RETRY_MAX_ATTEMPTS = 8;

export type SurfaceController = {
  start(): void;
  setFilters(patch: Partial<Pick<AnalyticsFilters, 'scope' | 'range' | 'directory'>>): void;
  refresh(): void;
  dispose(): Promise<void>;
  onSnapshot(listener: (snapshot: AnalyticsSnapshot) => void): () => void;
  onStatus(listener: (status: SurfaceStatus) => void): () => void;
  onError(listener: (message: string) => void): () => void;
  onHostContext(listener: (context: HostReadyContext) => void): () => void;
  getState(): SurfaceState;
};

/**
 * Lifecycle-safe controller shared by the full page and the rail panel.
 *
 * - Every request carries a monotonically increasing generation; responses
 *   arriving after a newer request are ignored, so stale filter results can
 *   never overwrite fresh data.
 * - Service-event bursts coalesce into one scheduled request; refreshes never
 *   overlap and queue a single follow-up.
 * - The browser timezone is detected initially and re-detected when the
 *   surface regains focus; it participates in every snapshot request.
 * - A new mount always fetches: service revisions are not replayable.
 * - An empty authoritative snapshot is distinct from a failed request; the
 *   last good snapshot survives failures.
 */
export function createSurfaceController(options: SurfaceControllerOptions): SurfaceController {
  const { bridge, surface } = options;
  const timeZoneProvider = options.timeZone ?? (() => resolveTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone));
  const eventDebounceMs = options.eventDebounceMs ?? 150;

  let disposed = false;
  let started = false;
  const unsubscribers: (() => void)[] = [];
  let status: SurfaceStatus = 'idle';
  let directory: string | null = null;
  /** True while filters.directory names an explicitly picked project. */
  let pinned = (options.preferences?.scope ?? 'all') === 'project' && options.preferences?.directory !== undefined;
  let snapshot: AnalyticsSnapshot | null = null;
  let generation = 0;
  let inFlight = false;
  let queued = false;
  let eventTimer: ReturnType<typeof setTimeout> | null = null;
  let lastEventSignature = '';
  const retryBaseMs = options.retryBaseMs ?? 1_000;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryAttempts = 0;

  /** The service may still be booting: retry with capped backoff until the first snapshot. */
  function scheduleRetry(): void {
    if (disposed || retryBaseMs <= 0 || snapshot !== null || retryTimer !== null || retryAttempts >= RETRY_MAX_ATTEMPTS) {
      return;
    }

    const delay = Math.min(retryBaseMs * 2 ** retryAttempts, RETRY_CAP_MS);
    retryAttempts += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      scheduleFetch();
    }, delay);
  }

  const snapshotListeners = new Set<(snapshot: AnalyticsSnapshot) => void>();
  const statusListeners = new Set<(status: SurfaceStatus) => void>();
  const errorListeners = new Set<(message: string) => void>();
  const hostContextListeners = new Set<(context: HostReadyContext) => void>();

  const filters: AnalyticsFilters = {
    scope: options.preferences?.scope ?? 'all',
    range: options.preferences?.range ?? '30d',
    surface,
    timeZone: timeZoneProvider(),
    directory: options.preferences?.directory,
  };

  function emitStatus(next: SurfaceStatus): void {
    status = next;

    for (const listener of statusListeners) {
      listener(status);
    }
  }

  function emitError(message: string): void {
    for (const listener of errorListeners) {
      listener(message);
    }
  }

  function currentFilters(): AnalyticsFilters {
    return {
      ...filters,
      // The stored directory wins once known; the host identity only fills in
      // for a follow-mode selection made before the context arrived.
      directory: filters.scope === 'project' ? (filters.directory ?? directory ?? undefined) : undefined,
    };
  }

  async function runFetch(): Promise<void> {
    const requestFilters = currentFilters();

    if (requestFilters.scope === 'project' && requestFilters.directory === undefined) {
      // No directory identity is resolvable yet (host context pending); the
      // service would reject the request. onReady/onDirectory schedule the
      // fetch once an identity exists.
      return;
    }

    inFlight = true;
    const requestGeneration = ++generation;

    emitStatus(snapshot === null ? 'loading' : 'refreshing');

    try {
      const result = await bridge.serviceRequest(snapshotRequest(requestFilters));

      if (disposed || requestGeneration !== generation) {
        return;
      }

      if (result.status !== 200) {
        // Failure keeps the last good snapshot visible.
        emitStatus('error');
        emitError(`snapshot request failed with status ${result.status}`);
        scheduleRetry();
        return;
      }

      const parsed = JSON.parse(result.body) as AnalyticsSnapshot;

      if (disposed || requestGeneration !== generation) {
        return;
      }

      // Empty authoritative snapshots are data too: an all-zero exact snapshot
      // is not an error.
      snapshot = parsed;
      retryAttempts = 0;
      emitStatus('ready');

      for (const listener of snapshotListeners) {
        listener(parsed);
      }
    } catch (error) {
      if (disposed || requestGeneration !== generation) {
        return;
      }

      emitStatus('error');
      emitError('snapshot request failed');
      scheduleRetry();
      void error;
    } finally {
      if (!disposed) {
        inFlight = false;

        if (queued) {
          queued = false;
          void runFetch();
        }
      }
    }
  }

  function scheduleFetch(): void {
    if (disposed) {
      return;
    }

    if (inFlight) {
      queued = true;
      return;
    }

    void runFetch();
  }

  function scheduleEventFetch(): void {
    if (disposed) {
      return;
    }

    if (eventDebounceMs <= 0) {
      scheduleFetch();
      return;
    }

    if (eventTimer !== null) {
      return;
    }

    eventTimer = setTimeout(() => {
      eventTimer = null;
      scheduleFetch();
    }, eventDebounceMs);
  }

  return {
    start() {
      if (started || disposed) {
        return;
      }

      started = true;

      // host.onReady() repeats: every snapshot carries the current context.
      unsubscribers.push(
        bridge.onReady((context) => {
          if (disposed) {
            return;
          }

          if (context.directory !== undefined) {
            directory = context.directory;

            // Follow-mode selections adopt the host identity on every ready
            // snapshot; a pinned project keeps its explicit directory.
            if (filters.scope === 'project' && !pinned && filters.directory !== context.directory) {
              filters.directory = context.directory ?? undefined;
              generation += 1;
              scheduleFetch();
            }
          }

          for (const listener of hostContextListeners) {
            listener(context);
          }

          // A fresh mount always fetches; repeated ready snapshots only fetch
          // while the surface has never received data.
          if (snapshot === null && !inFlight) {
            scheduleFetch();
          }
        }),
      );

      unsubscribers.push(
        bridge.onDirectory((value) => {
          if (disposed) {
            return;
          }

          if (value === directory) {
            return;
          }

          directory = value;

          if (filters.scope === 'project' && !pinned) {
            // Never retain a stale directory identity; a pinned project
            // deliberately ignores host directory changes.
            filters.directory = value ?? undefined;
            generation += 1;
            scheduleEventFetch();
          }        }),
      );

      unsubscribers.push(
        bridge.onServiceEvent((event) => {
        if (disposed) {
          return;
        }

        const signature = `${event.topic}:${JSON.stringify(event.data)}`;

        if (signature === lastEventSignature) {
          return;
        }

        lastEventSignature = signature;
        scheduleEventFetch();
        }),
      );

      const focusListener = (): void => {
        if (disposed) {
          return;
        }

        const zone = resolveTimeZone(timeZoneProvider());

        if (zone !== filters.timeZone) {
          filters.timeZone = zone;
          scheduleFetch();
        }
      };

      if (options.focusSource) {
        unsubscribers.push(options.focusSource(focusListener));
      } else if (typeof window !== 'undefined') {
        window.addEventListener('focus', focusListener);
        window.addEventListener('focusin', focusListener);
        unsubscribers.push(() => {
          window.removeEventListener('focus', focusListener);
          window.removeEventListener('focusin', focusListener);
        });
      }

      scheduleFetch();
    },

    setFilters(patch) {
      if (disposed) {
        return;
      }

      let changed = false;

      if (patch.range !== undefined && patch.range !== filters.range) {
        filters.range = patch.range;
        changed = true;
      }

      if (patch.scope !== undefined && patch.scope !== filters.scope) {
        filters.scope = patch.scope;
        changed = true;
      }

      if ((patch.scope ?? filters.scope) === 'all') {
        pinned = false;

        if (filters.directory !== undefined) {
          filters.directory = undefined;
          changed = true;
        }
      } else if (patch.directory !== undefined && patch.directory !== '') {
        // An explicit non-empty directory pins the project: host directory
        // changes no longer rewrite the identity.
        pinned = true;

        if (filters.directory !== patch.directory) {
          filters.directory = patch.directory;
          changed = true;
        }
      } else {
        // "This project": drop any pin and follow the host identity.
        const host = directory ?? undefined;

        if (pinned || filters.directory !== host) {
          pinned = false;
          filters.directory = host;
          changed = true;
        }
      }

      if (changed) {
        // A filter change invalidates any in-flight request so its response
        // can never overwrite the upcoming newer snapshot.
        generation += 1;
        scheduleFetch();
      }
    },

    refresh() {
      if (disposed) {
        return;
      }

      scheduleFetch();
    },

    async dispose() {
      if (disposed) {
        return;
      }

      disposed = true;
      started = false;

      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
      unsubscribers.length = 0;

      if (eventTimer !== null) {
        clearTimeout(eventTimer);
        eventTimer = null;
      }

      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }

      snapshotListeners.clear();
      statusListeners.clear();
      errorListeners.clear();
      hostContextListeners.clear();
    },

    onSnapshot(listener) {
      snapshotListeners.add(listener);
      return () => snapshotListeners.delete(listener);
    },

    onStatus(listener) {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },

    onError(listener) {
      errorListeners.add(listener);
      return () => errorListeners.delete(listener);
    },

    onHostContext(listener) {
      hostContextListeners.add(listener);
      return () => hostContextListeners.delete(listener);
    },

    getState(): SurfaceState {
      return {
        filters: currentFilters(),
        pinnedDirectory: filters.scope === 'project' && pinned ? filters.directory : undefined,
        directory,
        status,
        snapshot,
      };
    },
  };
}
