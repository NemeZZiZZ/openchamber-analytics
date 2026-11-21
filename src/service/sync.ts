import { normalizeDirectory } from './scope';
import type { AnalyticsStore } from './store';
import { snapshotEvent, sessionFingerprint } from './normalize';
import type { OpenCodeReader, OpenCodeStreamEvent } from './opencode';
import { createEventStream, type EventStreamHandle, type StreamTimers } from './event-stream';
import { createPriorityQueue } from './sync-queue';
import { createPeriodWindow } from './time';
import { reconcileSession } from './reconcile-session';
import type { AnalyticsFilters, CounterEvent, SessionRecord } from '../shared/analytics-types';

export const MESSAGE_WORKERS = 4;
/** Failed sessions are retried automatically this many times; a forced reconcile resets the budget. */
export const MAX_AUTOMATIC_ATTEMPTS = 8;
const DEFAULT_REVISION_COALESCE_MS = 750;
const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;
const DEFAULT_RETRY_CAP_DELAY_MS = 60_000;
const DEFAULT_RECONCILE_INTERVAL_MS = 5 * 60_000;
const DEFAULT_LIVE_SYNC_DEBOUNCE_MS = 2_000;

export type SyncEngineOptions = {
  reader: OpenCodeReader;
  store: AnalyticsStore;
  /** Injectable stream supervision; defaults to the real OpenCode event stream. */
  stream?: {
    subscribe(handlers: { onEvent: (event: OpenCodeStreamEvent) => void; onDisconnect: () => void }): () => void;
  };
  timers?: StreamTimers;
  workers?: number;
  revisionCoalesceMs?: number;
  retryBaseDelayMs?: number;
  retryCapDelayMs?: number;
  reconcileIntervalMs?: number;
  /** Quiet period after the last live usage event before a session's detail is re-downloaded. */
  liveSyncDebounceMs?: number;
  /** Receives swallowed background errors; defaults to console.error. */
  onError?: (context: string, error: unknown) => void;
};

export type SyncEngine = {
  start(): Promise<void>;
  setPriority(filters: AnalyticsFilters): void;
  refresh(): Promise<void>;
  reconcile(): Promise<void>;
  stop(): Promise<void>;
  onRevision(listener: (revision: number) => void): () => void;
  /** True once a full session list scan has succeeded since the last start. */
  sessionListComplete(): boolean;
};

function isAbortError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'name' in error &&
    (error as { name?: string }).name === 'AbortError'
  );
}

/**
 * True when a stored session only differs from the runtime's view by a newer
 * local timestamp: a live usage event already carried the same totals, so the
 * detail must not be downloaded again.
 */
function liveEventCovers(stored: SessionRecord, reported: SessionRecord): boolean {
  return (
    stored.timeUpdated >= reported.timeUpdated &&
    stored.providerID === reported.providerID &&
    stored.modelID === reported.modelID &&
    stored.variant === reported.variant &&
    stored.agent === reported.agent &&
    sameTokens(stored.tokens, reported.tokens) &&
    stored.cost === reported.cost
  );
}

function sameTokens(a: SessionRecord['tokens'], b: SessionRecord['tokens']): boolean {
  if (a === null || b === null) {
    return a === b;
  }

  return (
    a.input === b.input &&
    a.output === b.output &&
    a.reasoning === b.reasoning &&
    a.cache.read === b.cache.read &&
    a.cache.write === b.cache.write
  );
}

function sameFilters(a: AnalyticsFilters | null, b: AnalyticsFilters): boolean {
  return a !== null && a.range === b.range && a.scope === b.scope && a.timeZone === b.timeZone && a.directory === b.directory;
}

/** Metadata that can change without invalidating a session allocation. */
function sessionMetadataChanged(stored: SessionRecord, fresh: SessionRecord): boolean {
  return (
    stored.title !== fresh.title ||
    stored.directory !== fresh.directory ||
    stored.outcome !== fresh.outcome
  );
}

/**
 * Progressive analytics synchronization.
 *
 * Bootstraps normalized session snapshots first, then fetches assistant
 * message history through a bounded, priority-ordered worker pool. Every
 * completed session checkpoints through the store before the next revision is
 * claimed. Live usage events replace allocations as provisional totals —
 * never additive deltas — and every stream reset forces a full
 * reconciliation because no upstream instance identity is available.
 *
 * Every fire-and-forget path is guarded: a failing OpenCode or disk must never
 * surface as an unhandled rejection that would take the service down.
 */
export function createSyncEngine(options: SyncEngineOptions): SyncEngine {
  const store = options.store;
  const reader = options.reader;
  const timers = options.timers;
  const workers = options.workers ?? MESSAGE_WORKERS;
  const revisionCoalesceMs = options.revisionCoalesceMs ?? DEFAULT_REVISION_COALESCE_MS;
  const retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
  const retryCapDelayMs = options.retryCapDelayMs ?? DEFAULT_RETRY_CAP_DELAY_MS;
  const reconcileIntervalMs = options.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS;
  const liveSyncDebounceMs = options.liveSyncDebounceMs ?? DEFAULT_LIVE_SYNC_DEBOUNCE_MS;
  const reportError = options.onError ?? ((context: string, error: unknown) => {
    console.error(`[analytics] ${context}:`, error instanceof Error ? error.message : error);
  });

  const queue = createPriorityQueue();
  const revisionListeners = new Set<(revision: number) => void>();
  const backgroundOperations = new Set<Promise<unknown>>();
  const retryTimers = new Map<string, unknown>();
  const liveSyncTimers = new Map<string, unknown>();
  const idleWorkers: Array<() => void> = [];

  let controller = new AbortController();
  let stopped = true;
  let generation = 0;
  let bootstrap: Promise<void> = Promise.resolve();
  let workerRuns: Promise<void>[] = [];
  let bootstrapRetryTimer: unknown = null;
  let streamHandle: { unsubscribe: () => void; stop?: () => Promise<void> } | null = null;
  let reconcileTimer: unknown = null;
  let lastFilters: AnalyticsFilters | null = null;
  let startedAt = 0;
  let listComplete = false;

  let pendingRevisionEmit: unknown = null;
  let latestRevision = 0;

  function schedule(delayMs: number, callback: () => void): unknown {
    if (timers) {
      return timers.setTimeout(callback, delayMs);
    }

    return setTimeout(callback, delayMs);
  }

  function cancelTimer(handle: unknown): void {
    if (timers) {
      timers.clearTimeout(handle);
    } else {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    }
  }

  /** Runs a background task; failures are reported but never propagate. */
  function safe(context: string, task: () => Promise<unknown>): void {
    const operation = (async () => {
      try {
        await task();
      } catch (error) {
        if (!isAbortError(error) && !stopped) {
          reportError(context, error);
        }
      }
    })();

    // Live/stream work can hold a store mutation across generations. Retain
    // each operation so shutdown waits for it before the next generation
    // starts; otherwise a reset could clear storage while the write is held.
    backgroundOperations.add(operation);
    const release = (): void => {
      backgroundOperations.delete(operation);
    };
    void operation.then(release, release);
  }

  function emitRevision(revision: number): void {
    latestRevision = Math.max(latestRevision, revision);

    if (revisionCoalesceMs <= 0 || stopped) {
      for (const listener of revisionListeners) {
        listener(latestRevision);
      }

      return;
    }

    if (pendingRevisionEmit !== null) {
      return;
    }

    pendingRevisionEmit = schedule(revisionCoalesceMs, () => {
      pendingRevisionEmit = null;

      for (const listener of revisionListeners) {
        listener(latestRevision);
      }
    });
  }

  function bumpRevision(): number {
    const revision = store.nextRevision();
    emitRevision(revision);
    return revision;
  }

  function wakeWorkers(): void {
    for (const wake of idleWorkers.splice(0)) {
      wake();
    }
  }

  /** Priority for the visible selection: current period, comparison, then history. */
  function priorityFor(session: SessionRecord, window: ReturnType<typeof createPeriodWindow> | null): number {
    if (!lastFilters || !window) {
      return 2;
    }

    let priority = 2;

    if (session.timeUpdated >= window.startMs && session.timeUpdated <= window.endMs) {
      priority = 0;
    } else if (window.previous && session.timeUpdated >= window.previous.startMs && session.timeUpdated <= window.previous.endMs) {
      priority = 1;
    }

    if (lastFilters.scope === 'project' && lastFilters.directory !== undefined && normalizeDirectory(session.directory) !== normalizeDirectory(lastFilters.directory)) {
      priority += 10;
    }

    return priority;
  }

  function currentWindow(): ReturnType<typeof createPeriodWindow> | null {
    return lastFilters
      ? createPeriodWindow(lastFilters.range, Math.max(startedAt, Date.now()), lastFilters.timeZone)
      : null;
  }

  function enqueue(sessionId: string, window: ReturnType<typeof createPeriodWindow> | null = currentWindow()): void {
    const record = store.getSession(sessionId);

    if (!record) {
      return;
    }

    queue.push(sessionId, priorityFor(record.session, window), record.session.timeUpdated);
    wakeWorkers();
  }

  /** Coalesces a burst of live usage events into one detail download per session. */
  function enqueueAfterLiveQuietPeriod(sessionId: string): void {
    if (liveSyncDebounceMs <= 0) {
      enqueue(sessionId);
      return;
    }

    const existing = liveSyncTimers.get(sessionId);

    if (existing !== undefined) {
      cancelTimer(existing);
    }

    liveSyncTimers.set(
      sessionId,
      schedule(liveSyncDebounceMs, () => {
        liveSyncTimers.delete(sessionId);

        if (!stopped) {
          enqueue(sessionId);
        }
      }),
    );
  }

  function reschedulePriorities(): void {
    if (queue.size() === 0) {
      return;
    }

    const window = currentWindow();

    for (const record of store.listSessions()) {
      if (queue.has(record.sessionId)) {
        queue.setPriority(record.sessionId, priorityFor(record.session, window));
      }
    }
  }

  async function recordFailure(sessionId: string, fingerprint: string, error: unknown): Promise<void> {
    // A live update or deletion during the failing fetch makes this failure
    // moot: never revert a newer fingerprint to the stale one.
    const record = store.getSession(sessionId);

    if (!record || record.fingerprint !== fingerprint) {
      if (record) {
        enqueue(sessionId);
      }

      return;
    }

    const attempts = record.attempts + 1;
    bumpRevision();
    const snapshot = snapshotEvent(record.session);

    await store.replaceAllocation(sessionId, fingerprint, {
      state: 'failed',
      // Keep the provisional snapshot visible; failures never erase data.
      events: record.events.some((event) => event.source === 'session-snapshot')
        ? record.events
        : snapshot
          ? [snapshot]
          : [],
      attempts,
      lastError: error instanceof Error ? error.message : String(error),
      syncedAt: Date.now(),
    });

    if (attempts >= MAX_AUTOMATIC_ATTEMPTS) {
      // Budget exhausted: only an explicit refresh/reconcile retries again.
      return;
    }

    // Capped exponential retry.
    const delay = Math.min(retryBaseDelayMs * 2 ** (attempts - 1), retryCapDelayMs);
    const existing = retryTimers.get(sessionId);

    if (existing !== undefined) {
      cancelTimer(existing);
    }

    retryTimers.set(
      sessionId,
      schedule(delay, () => {
        retryTimers.delete(sessionId);

        if (!stopped && !controller.signal.aborted) {
          enqueue(sessionId);
        }
      }),
    );
  }

  async function syncSession(sessionId: string): Promise<void> {
    const owner = generation;
    const record = store.getSession(sessionId);

    if (!record) {
      return;
    }

    try {
      const result = await reconcileSession(
        record.session,
        reader.listAssistantMessages(record.session, controller.signal),
      );

      // Stop/reset/start invalidates in-flight work: even a result that
      // ignored abort must not overwrite the newer generation.
      if (stopped || owner !== generation) {
        return;
      }

      // A live usage update may have changed the stored fingerprint while the
      // detail fetch ran; stale allocations are dropped and re-synced instead.
      const fresh = store.getSession(sessionId);

      if (!fresh || fresh.fingerprint !== record.fingerprint) {
        if (fresh) {
          enqueue(sessionId);
        }

        return;
      }

      bumpRevision();

      await store.replaceAllocation(sessionId, record.fingerprint, {
        state: result.state,
        events: result.events,
        attempts: record.attempts + 1,
        syncedAt: Date.now(),
      });
    } catch (error) {
      if (stopped || owner !== generation || controller.signal.aborted || isAbortError(error)) {
        return;
      }

      try {
        await recordFailure(sessionId, record.fingerprint, error);
      } catch (writeError) {
        reportError(`recording failure for ${sessionId}`, writeError);
      }
    }
  }

  function startWorkers(): void {
    workerRuns = [];

    for (let index = 0; index < workers; index += 1) {
      workerRuns.push((async () => {
        while (!stopped) {
          const sessionId = queue.pop();

          if (sessionId === null) {
            await new Promise<void>((resolve) => {
              idleWorkers.push(resolve);
            });
            continue;
          }

          try {
            await syncSession(sessionId);
          } catch (error) {
            reportError(`syncing ${sessionId}`, error);
          }
        }
      })());
    }
  }

  async function scanSessionList(force = false): Promise<void> {
    const owner = generation;
    const scanActive = (): boolean => !stopped && owner === generation;
    const seen = new Set<string>();
    const existing = new Map(store.listSessions().map((record) => [record.sessionId, record]));
    const window = currentWindow();

    for await (const session of reader.listSessions(controller.signal)) {
      // A reset/start creates a newer generation: stale reads must not write.
      if (!scanActive()) {
        return;
      }

      seen.add(session.sessionId);
      const current = existing.get(session.sessionId);
      const fingerprint = sessionFingerprint(session);

      if (current && (current.fingerprint === fingerprint || liveEventCovers(current.session, session))) {
        if (sessionMetadataChanged(current.session, session)) {
          if (!scanActive()) {
            return;
          }

          // Metadata changes never invalidate the allocation, but they must
          // invalidate revision-cached snapshots and notify open surfaces.
          await store.updateSessionMetadata(session);
          emitRevision(store.currentRevision());
        }

        continue;
      }

      // Fresh or changed session: the provisional snapshot replaces any
      // previous allocation, and detail is re-fetched.
      if (!scanActive()) {
        return;
      }

      const snapshot = snapshotEvent(session);
      bumpRevision();

      await store.upsertSession({
        sessionId: session.sessionId,
        session,
        fingerprint,
        state: 'pending',
        attempts: 0,
        syncedAt: current?.syncedAt,
        events: snapshot ? [snapshot] : [],
      });

      enqueue(session.sessionId, window);
    }

    // Unfinished work never depends on in-memory state: whatever is still
    // pending, failed or mismatched is queued again after every scan.
    if (!scanActive()) {
      return;
    }

    for (const record of store.listSessions()) {
      if (!seen.has(record.sessionId) || record.state === 'complete') {
        continue;
      }

      if (record.state === 'mismatch' && !force) {
        continue;
      }

      if (record.state === 'failed' && record.attempts >= MAX_AUTOMATIC_ATTEMPTS && !force) {
        continue;
      }

      if (force && (record.state === 'failed' || record.state === 'mismatch') && record.attempts > 0) {
        if (!scanActive()) {
          return;
        }

        await store.replaceAllocation(record.sessionId, record.fingerprint, {
          state: record.state,
          events: record.events,
          attempts: 0,
          lastError: record.lastError,
          syncedAt: record.syncedAt,
        });
      }

      enqueue(record.sessionId, window);
    }

    // Deletion reconciliation: remove stored sessions the runtime no longer
    // reports, confirming each deletion against the live transport.
    for (const record of existing.values()) {
      if (seen.has(record.sessionId)) {
        continue;
      }

      const confirmed = await reader.getSession(record.sessionId, controller.signal);

      // A stale confirmation must not delete a newer generation’s record.
      if (!scanActive()) {
        return;
      }

      if (confirmed === null) {
        await store.removeSession(record.sessionId);
        queue.remove(record.sessionId);
        bumpRevision();
      }
    }

    if (!scanActive()) {
      return;
    }

    if (!listComplete) {
      listComplete = true;
      // The first complete scan changes how coverage reads (an empty list is
      // now authoritative), so subscribers must refetch.
      bumpRevision();
    }
  }

  let reconcileRunning = false;

  async function reconcileNow(force = false): Promise<void> {
    if (reconcileRunning || stopped) {
      return;
    }

    reconcileRunning = true;

    try {
      await scanSessionList(force);
    } finally {
      reconcileRunning = false;
    }
  }

  let forcedScan: Promise<void> | null = null;

  /** Explicit commands wait for a running scan, then run one forced scan; concurrent callers share it. */
  function runForcedScan(): Promise<void> {
    if (forcedScan) {
      return forcedScan;
    }

    const run = (async () => {
      while (reconcileRunning) {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }

      await reconcileNow(true);
    })().finally(() => {
      forcedScan = null;
    });

    forcedScan = run;
    return run;
  }

  function handleLiveEvent(event: OpenCodeStreamEvent): void {
    if (stopped) {
      return;
    }

    if (event.type === 'session.usage.updated') {
      const record = store.getSession(event.sessionID);

      if (!record) {
        // A session the store has not seen yet: pick it up now instead of
        // waiting for the next periodic reconcile.
        safe('reconcile after unknown session event', () => reconcileNow());
        return;
      }

      if (event.tokens === null || event.cost === null) {
        // A partial payload is only a hint: re-read the session instead of
        // replacing its totals with zeros.
        enqueue(record.sessionId);
        return;
      }

      // Treat the event as a total snapshot: the provisional allocation is
      // replaced wholesale, so repeated events never accumulate.
      const updatedSession: SessionRecord = {
        ...record.session,
        tokens: event.tokens,
        cost: event.cost,
        timeUpdated: Math.max(record.session.timeUpdated, Date.now()),
      };

      const snapshot = snapshotEvent(updatedSession);

      safe('applying live usage update', async () => {
        await store.upsertSession({
          sessionId: updatedSession.sessionId,
          session: updatedSession,
          fingerprint: sessionFingerprint(updatedSession),
          state: 'pending',
          attempts: record.attempts,
          events: snapshot ? [snapshot] : [],
        });
        bumpRevision();
        enqueueAfterLiveQuietPeriod(updatedSession.sessionId);
      });

      return;
    }

    if (event.type === 'session.deleted') {
      // Deletion is confirmed by reconciliation, not trusted blindly.
      safe('reconcile after session deletion', () => reconcileNow());
      return;
    }

    if (event.type === 'counter') {
      handleCounterEvent(event);
    }
  }

  /** Open permission asks waiting for their reply to measure human wait time. */
  const pendingPermissionWaits = new Map<string, number>();
  const PENDING_PERMISSION_LIMIT = 256;

  function handleCounterEvent(event: Extract<OpenCodeStreamEvent, { type: 'counter' }>): void {
    const records: CounterEvent[] = [{ kind: event.kind, sessionID: event.sessionID, timestamp: event.timestamp }];

    if (event.kind === 'permissionAsked' && event.permissionID !== undefined) {
      // Bounded by insertion order: the oldest unanswered ask drops first.
      if (pendingPermissionWaits.size >= PENDING_PERMISSION_LIMIT) {
        const oldest = pendingPermissionWaits.keys().next().value;
        pendingPermissionWaits.delete(oldest === undefined ? '' : oldest);
      }

      pendingPermissionWaits.set(event.permissionID, event.timestamp);
    } else if (event.kind === 'permissionReplied' && event.permissionID !== undefined) {
      const askedAt = pendingPermissionWaits.get(event.permissionID);
      pendingPermissionWaits.delete(event.permissionID);

      if (askedAt !== undefined && event.timestamp >= askedAt) {
        records.push({
          kind: 'permissionWait',
          sessionID: event.sessionID,
          timestamp: event.timestamp,
          ms: event.timestamp - askedAt,
        });
      }
    }

    safe('recording stream counter', async () => {
      for (const record of records) {
        await store.recordCounter(record);
      }

      // recordCounter owns the revision bump; only notify subscribers here.
      emitRevision(store.currentRevision());
    });
  }

  function scheduleBootstrapRetry(attempt: number): void {
    const delay = Math.min(retryBaseDelayMs * 2 ** attempt, retryCapDelayMs);
    const owner = generation;

    bootstrapRetryTimer = schedule(delay, () => {
      bootstrapRetryTimer = null;

      if (stopped || owner !== generation) {
        return;
      }

      void (async () => {
        try {
          await scanSessionList();
        } catch (error) {
          if (stopped || owner !== generation || isAbortError(error)) {
            return;
          }

          reportError('session list bootstrap', error);
          scheduleBootstrapRetry(attempt + 1);
        }
      })();
    });
  }

  function scheduleReconcile(owner: number): void {
    reconcileTimer = schedule(reconcileIntervalMs, () => {
      reconcileTimer = null;

      if (stopped || owner !== generation) {
        return;
      }

      void (async () => {
        try {
          await reconcileNow();
        } catch (error) {
          if (!stopped && !isAbortError(error)) {
            reportError('periodic reconcile', error);
          }
        } finally {
          if (!stopped && owner === generation) {
            scheduleReconcile(owner);
          }
        }
      })();
    });
  }

  return {
    async start() {
      if (!stopped) {
        return;
      }

      stopped = false;
      generation += 1;
      listComplete = false;
      controller = new AbortController();
      startedAt = Date.now();

      // A transient OpenCode failure at boot must not take the service down:
      // retry with capped backoff while everything else keeps running.
      bootstrap = (async () => {
        try {
          await scanSessionList();
        } catch (error) {
          if (stopped || isAbortError(error)) {
            return;
          }

          reportError('session list bootstrap', error);
          scheduleBootstrapRetry(0);
        }
      })();
      await bootstrap;

      if (stopped) {
        return;
      }

      startWorkers();

      const onDisconnect = (): void => {
        // Upstream identity is unavailable after a stream reset:
        // reconcile instead of assuming one continuous upstream.
        if (!stopped) {
          safe('reconcile after stream disconnect', () => reconcileNow());
        }
      };

      if (options.stream) {
        streamHandle = {
          unsubscribe: options.stream.subscribe({ onEvent: handleLiveEvent, onDisconnect }),
        };
      } else {
        const handle: EventStreamHandle = createEventStream({
          reader,
          onEvent: handleLiveEvent,
          onDisconnect,
          timers,
        });
        handle.start();
        streamHandle = { unsubscribe: () => undefined, stop: () => handle.stop() };
      }

      if (reconcileIntervalMs > 0) {
        scheduleReconcile(generation);
      }
    },

    setPriority(filters) {
      if (sameFilters(lastFilters, filters)) {
        return;
      }

      lastFilters = filters;
      reschedulePriorities();
    },

    async refresh() {
      await runForcedScan();
    },

    async reconcile() {
      await runForcedScan();
    },

    sessionListComplete() {
      return listComplete;
    },

    async stop() {
      if (stopped) {
        return;
      }

      stopped = true;
      generation += 1;

      if (pendingRevisionEmit !== null) {
        cancelTimer(pendingRevisionEmit);
        pendingRevisionEmit = null;

        for (const listener of revisionListeners) {
          listener(latestRevision);
        }
      }

      for (const timer of retryTimers.values()) {
        cancelTimer(timer);
      }

      retryTimers.clear();

      for (const timer of liveSyncTimers.values()) {
        cancelTimer(timer);
      }

      liveSyncTimers.clear();

      for (const handle of [reconcileTimer, bootstrapRetryTimer]) {
        if (handle !== null) {
          cancelTimer(handle);
        }
      }

      reconcileTimer = null;
      bootstrapRetryTimer = null;

      queue.clear();
      controller.abort();
      wakeWorkers();

      if (streamHandle?.stop) {
        await streamHandle.stop();
      }

      streamHandle?.unsubscribe();
      streamHandle = null;
      await bootstrap.catch(() => undefined);
      await Promise.all(workerRuns);
      workerRuns = [];
      await Promise.all([...backgroundOperations]);
    },

    onRevision(listener) {
      revisionListeners.add(listener);
      return () => revisionListeners.delete(listener);
    },
  };
}
