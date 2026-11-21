import type { CounterEvent, SessionRecord, SessionSyncState, StoredSessionAnalytics, UsageEvent } from '../shared/analytics-types';
import { snapshotEvent } from './normalize';
import {
  appendJsonLine,
  compactFiles,
  countersPath,
  ensureDataDir,
  eventsPath,
  enforcePrivatePermissions,
  readJsonLines,
  readManifest,
  repairTrailingNewline,
  sessionsPath,
  writeManifest,
  type AllocationLine,
  type CounterLine,
  type SessionLine,
  type StoreManifest,
  MANIFEST_SCHEMA_VERSION,
} from './store-files';

export type AllocationCheckpoint = {
  state: SessionSyncState;
  events: UsageEvent[];
  attempts?: number;
  lastError?: string;
  syncedAt?: number;
};

export type AnalyticsStore = {
  listSessions(): StoredSessionAnalytics[];
  getSession(sessionId: string): StoredSessionAnalytics | null;
  upsertSession(session: StoredSessionAnalytics): Promise<void>;
  replaceAllocation(sessionId: string, fingerprint: string, allocation: AllocationCheckpoint): Promise<void>;
  /**
   * Replaces session metadata while keeping fingerprint, allocation and sync
   * state untouched. A real metadata change still bumps revision so cached
   * snapshots and open surfaces cannot keep stale titles or project membership.
   */
  updateSessionMetadata(session: SessionRecord): Promise<void>;
  removeSession(sessionId: string): Promise<void>;
  /** Appends one counted occurrence and bumps the revision. */
  recordCounter(event: CounterEvent): Promise<void>;
  listCounters(): CounterEvent[];
  /** Current persisted revision without incrementing it. */
  currentRevision(): number;
  nextRevision(): number;
  reset(): Promise<void>;
  close(): Promise<void>;
};

type LiveRecord = {
  session: SessionRecord;
  fingerprint: string;
  state: SessionSyncState;
  attempts: number;
  lastError?: string;
  syncedAt?: number;
  events: UsageEvent[];
};

/** Compaction never runs below this many lines, and then only after the log has grown 3x past its last compacted size. */
const COMPACTION_MIN_LINES = 256;
const COMPACTION_GROWTH_FACTOR = 3;

function isValidSessionRecord(value: unknown): value is SessionRecord {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const record = value as Partial<SessionRecord>;
  return (
    typeof record.sessionId === 'string' &&
    record.sessionId !== '' &&
    Number.isFinite(record.timeCreated) &&
    Number.isFinite(record.timeUpdated)
  );
}

function isFiniteTokens(value: unknown): boolean {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const tokens = value as Record<string, unknown>;
  const cache = typeof tokens.cache === 'object' && tokens.cache !== null ? (tokens.cache as Record<string, unknown>) : null;

  return (
    ['input', 'output', 'reasoning'].every((key) => Number.isFinite(tokens[key])) &&
    cache !== null &&
    Number.isFinite(cache.read) &&
    Number.isFinite(cache.write)
  );
}

function isValidUsageEvent(event: unknown): event is UsageEvent {
  if (event === null || typeof event !== 'object') {
    return false;
  }

  const candidate = event as Partial<UsageEvent>;
  return (
    typeof candidate.sessionId === 'string' &&
    Number.isFinite(candidate.timestamp) &&
    Number.isFinite(candidate.cost) &&
    isFiniteTokens(candidate.tokens)
  );
}

function asSessionState(value: string): SessionSyncState {
  // A legacy "syncing" line (never written by any released version) reloads
  // as pending, which is the safe resync path.
  if (value === 'complete' || value === 'failed' || value === 'mismatch') {
    return value;
  }

  return 'pending';
}

function asUsageEvents(value: unknown[]): UsageEvent[] {
  return value.filter(isValidUsageEvent);
}

/**
 * Durable numeric analytics store.
 *
 * Canonical files in OPENCHAMBER_SERVICE_DATA_DIR:
 * - `manifest.json`: versioned schema, revision counter, generation (atomic rename);
 * - `sessions.jsonl`: session metadata, sync state, tombstones (append-only);
 * - `events.jsonl`: allocation checkpoints tagged with the session fingerprint.
 *
 * Loads resolve duplicate records by taking the last line and recover from a
 * truncated final write by skipping malformed lines. An allocation whose
 * fingerprint no longer matches the session is discarded in favor of a fresh
 * provisional snapshot allocation. Only numeric analytics and metadata are
 * persisted; raw message content never reaches the store.
 */
export async function openAnalyticsStore(dataDir: string): Promise<AnalyticsStore> {
  await ensureDataDir(dataDir);
  await enforcePrivatePermissions(dataDir);

  const manifest: StoreManifest = (await readManifest(dataDir)) ?? {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    revision: 0,
    generation: 1,
  };

  let revision = manifest.revision;
  let closed = false;

  const live = new Map<string, LiveRecord>();
  const counters: CounterEvent[] = [];
  let sessionLineCount = 0;
  let allocationLineCount = 0;
  let counterLineCount = 0;
  let linesAtLastCompaction = 0;

  // Serialize all file writes to keep appends line-atomic.
  let writeQueue: Promise<void> = Promise.resolve();

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = writeQueue.then(operation, operation);
    writeQueue = run.then(() => undefined, () => undefined);
    return run;
  };

  async function load(): Promise<void> {
    await repairTrailingNewline(sessionsPath(dataDir));
    await repairTrailingNewline(eventsPath(dataDir));
    await repairTrailingNewline(countersPath(dataDir));

    const sessionLines = await readJsonLines<SessionLine | { sessionId: string; deleted: true }>(sessionsPath(dataDir));
    const allocationLines = await readJsonLines<AllocationLine>(eventsPath(dataDir));

    sessionLineCount = 0;

    for (const line of sessionLines) {
      sessionLineCount += 1;

      if (line === null || typeof line !== 'object' || typeof line.sessionId !== 'string') {
        continue;
      }

      if ('deleted' in line) {
        live.delete(line.sessionId);
        continue;
      }

      if (!isValidSessionRecord(line.session)) {
        continue;
      }

      live.set(line.sessionId, {
        session: line.session,
        fingerprint: line.fingerprint,
        state: asSessionState(line.state),
        attempts: typeof line.attempts === 'number' ? line.attempts : 0,
        lastError: line.lastError,
        syncedAt: line.syncedAt,
        events: [],
      });
    }

    allocationLineCount = 0;

    for (const line of allocationLines) {
      allocationLineCount += 1;

      if (line === null || typeof line !== 'object') {
        continue;
      }

      const record = live.get(line.sessionId);

      if (!record) {
        continue;
      }

      if (line.fingerprint !== record.fingerprint) {
        // Allocation belongs to an older session revision: stale, ignored.
        continue;
      }

      record.state = asSessionState(line.state);
      record.events = asUsageEvents(line.events ?? []);
      record.attempts = typeof line.attempts === 'number' ? line.attempts : record.attempts;
      record.lastError = line.lastError;
      record.syncedAt = line.syncedAt;
    }

    // Sessions without a valid allocation keep their provisional snapshot so
    // pending, failed, and mismatch records stay visibly represented.
    for (const record of live.values()) {
      if (record.events.length === 0 && record.state !== 'complete') {
        const snapshot = snapshotEvent(record.session);
        record.events = snapshot ? [snapshot] : [];
      }
    }

    counterLineCount = 0;

    for (const line of await readJsonLines<CounterLine>(countersPath(dataDir))) {
      counterLineCount += 1;

      if (line === null || typeof line !== 'object') {
        continue;
      }

      const candidate = line as Partial<CounterEvent>;
      const kind = candidate.kind;
      const sessionID = candidate.sessionID;
      const timestamp = candidate.timestamp;

      if (typeof kind === 'string' && typeof sessionID === 'string' && typeof timestamp === 'number' && Number.isFinite(timestamp)) {
        counters.push({
          kind,
          sessionID,
          timestamp,
          ms: Number.isFinite(candidate.ms) ? candidate.ms : undefined,
        });
      }
    }
  }

  await load();
  linesAtLastCompaction = sessionLineCount + allocationLineCount;

  // The manifest only changes with the revision, generation or reconciliation
  // stamp; appends of session/allocation lines never need to rewrite it.
  let lastManifestKey: string | null = null;
  let manifestWriteQueued = false;

  async function persistManifest(force = false): Promise<void> {
    const next = { ...manifest, revision, lastReconciliation: manifest.lastReconciliation };
    const key = JSON.stringify(next);

    if (!force && key === lastManifestKey) {
      return;
    }

    await writeManifest(dataDir, next);
    lastManifestKey = key;
  }

  async function compactIfNeeded(): Promise<void> {
    const lines = sessionLineCount + allocationLineCount + counterLineCount;
    const threshold = Math.max(COMPACTION_MIN_LINES, linesAtLastCompaction * COMPACTION_GROWTH_FACTOR);

    if (lines <= threshold) {
      return;
    }

    const sessionLines: SessionLine[] = [...live.values()].map((record) => ({
      sessionId: record.session.sessionId,
      session: record.session,
      fingerprint: record.fingerprint,
      state: record.state,
      attempts: record.attempts,
      lastError: record.lastError,
      syncedAt: record.syncedAt,
    }));

    const allocationLines: AllocationLine[] = [...live.values()].map((record) => ({
      sessionId: record.session.sessionId,
      fingerprint: record.fingerprint,
      state: record.state,
      events: record.events,
      attempts: record.attempts,
      lastError: record.lastError,
      syncedAt: record.syncedAt,
    }));

    await compactFiles(dataDir, sessionLines, allocationLines, { ...manifest, revision }, counters);
    sessionLineCount = sessionLines.length;
    allocationLineCount = allocationLines.length;
    counterLineCount = counters.length;
    linesAtLastCompaction = sessionLineCount + allocationLineCount + counterLineCount;
  }

  function toStored(record: LiveRecord): StoredSessionAnalytics {
    return {
      sessionId: record.session.sessionId,
      session: record.session,
      fingerprint: record.fingerprint,
      state: record.state,
      attempts: record.attempts,
      lastError: record.lastError,
      syncedAt: record.syncedAt,
      events: record.events,
    };
  }

  return {
    listSessions(): StoredSessionAnalytics[] {
      return [...live.values()].map(toStored);
    },

    getSession(sessionId: string): StoredSessionAnalytics | null {
      const record = live.get(sessionId);
      return record ? toStored(record) : null;
    },

    async upsertSession(record: StoredSessionAnalytics): Promise<void> {
      if (closed) {
        throw new Error('store is closed');
      }

      if (!isValidSessionRecord(record.session) || record.session.sessionId !== record.sessionId) {
        throw new Error('invalid session record');
      }

      live.set(record.sessionId, {
        session: record.session,
        fingerprint: record.fingerprint,
        state: record.state,
        attempts: record.attempts,
        lastError: record.lastError,
        syncedAt: record.syncedAt,
        events: record.events,
      });

      await enqueue(async () => {
        const line: SessionLine = {
          sessionId: record.sessionId,
          session: record.session,
          fingerprint: record.fingerprint,
          state: record.state,
          attempts: record.attempts,
          lastError: record.lastError,
          syncedAt: record.syncedAt,
        };

        await appendJsonLine(sessionsPath(dataDir), line);
        sessionLineCount += 1;

        if (record.events.length > 0) {
          const allocation: AllocationLine = {
            sessionId: record.sessionId,
            fingerprint: record.fingerprint,
            state: record.state,
            events: record.events,
            attempts: record.attempts,
            lastError: record.lastError,
            syncedAt: record.syncedAt,
          };

          await appendJsonLine(eventsPath(dataDir), allocation);
          allocationLineCount += 1;
        }

        await persistManifest();
        await compactIfNeeded();
      });
    },

    async replaceAllocation(sessionId, fingerprint, allocation) {
      if (closed) {
        throw new Error('store is closed');
      }

      const existing = live.get(sessionId);

      if (!existing) {
        throw new Error(`unknown session: ${sessionId}`);
      }

      existing.fingerprint = fingerprint;
      existing.state = allocation.state;
      existing.events = allocation.events;
      existing.attempts = allocation.attempts ?? existing.attempts;
      existing.lastError = allocation.lastError;
      existing.syncedAt = allocation.syncedAt;

      await enqueue(async () => {
        // Allocation first, session line second: a crash in between leaves the
        // old session fingerprint on disk, so the orphan allocation is ignored
        // on load and the session is simply synced again (never "complete"
        // with an empty allocation).
        const line: AllocationLine = {
          sessionId,
          fingerprint,
          state: allocation.state,
          events: allocation.events,
          attempts: existing.attempts,
          lastError: allocation.lastError,
          syncedAt: allocation.syncedAt,
        };

        await appendJsonLine(eventsPath(dataDir), line);
        allocationLineCount += 1;

        const sessionLine: SessionLine = {
          sessionId,
          session: existing.session,
          fingerprint,
          state: allocation.state,
          attempts: existing.attempts,
          lastError: allocation.lastError,
          syncedAt: allocation.syncedAt,
        };

        await appendJsonLine(sessionsPath(dataDir), sessionLine);
        sessionLineCount += 1;
        await persistManifest();
        await compactIfNeeded();
      });
    },

    async updateSessionMetadata(session) {
      if (closed) {
        throw new Error('store is closed');
      }

      const existing = live.get(session.sessionId);

      if (!existing) {
        return;
      }

      existing.session = session;
      revision += 1;

      await enqueue(async () => {
        await appendJsonLine(sessionsPath(dataDir), {
          sessionId: session.sessionId,
          session,
          fingerprint: existing.fingerprint,
          state: existing.state,
          attempts: existing.attempts,
          lastError: existing.lastError,
          syncedAt: existing.syncedAt,
        } satisfies SessionLine);
        sessionLineCount += 1;
        await persistManifest();
        await compactIfNeeded();
      });
    },

    async recordCounter(event) {
      if (closed) {
        throw new Error('store is closed');
      }

      counters.push(event);
      revision += 1;

      await enqueue(async () => {
        await appendJsonLine(countersPath(dataDir), event);
        counterLineCount += 1;
        await persistManifest();
        await compactIfNeeded();
      });
    },

    listCounters(): CounterEvent[] {
      return counters.slice();
    },

    async removeSession(sessionId) {
      if (closed) {
        throw new Error('store is closed');
      }

      if (!live.has(sessionId)) {
        return;
      }

      live.delete(sessionId);

      await enqueue(async () => {
        await appendJsonLine(sessionsPath(dataDir), { sessionId, deleted: true });
        sessionLineCount += 1;
        await persistManifest();
        await compactIfNeeded();
      });
    },

    currentRevision(): number {
      return revision;
    },

    nextRevision(): number {
      revision += 1;

      // Persist the counter through the write queue; a lost race here only
      // costs a resume-at value, but serializing keeps file writes sane.
      // Bumps that arrive while a manifest write is still queued share it.
      if (!manifestWriteQueued) {
        manifestWriteQueued = true;
        void enqueue(async () => {
          manifestWriteQueued = false;
          await persistManifest();
        }).catch(() => undefined);
      }

      return revision;
    },

    async reset() {
      if (closed) {
        throw new Error('store is closed');
      }

      await enqueue(async () => {
        // Do not expose an empty in-memory store unless the durable replacement
        // succeeded. A failed reset must leave both views on the same data.
        const nextRevision = revision + 1;
        const nextGeneration = manifest.generation + 1;
        await compactFiles(dataDir, [], [], { ...manifest, revision: nextRevision, generation: nextGeneration }, []);

        live.clear();
        // Revisions stay monotonic across reset so de-duplicating subscribers
        // never swallow the first post-reset change.
        revision = nextRevision;
        manifest.generation = nextGeneration;
        counters.length = 0;
        sessionLineCount = 0;
        allocationLineCount = 0;
        counterLineCount = 0;
        linesAtLastCompaction = 0;
      });
    },

    async close() {
      if (closed) {
        return;
      }

      await enqueue(() => persistManifest());
      closed = true;
    },
  };
}
