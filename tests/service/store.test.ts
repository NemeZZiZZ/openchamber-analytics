import { mkdtemp, readFile, rm, appendFile, chmod, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openAnalyticsStore } from '../../src/service/store';
import { snapshotEvent, normalizeSession } from '../../src/service/normalize';
import type { SessionRecord, StoredSessionAnalytics, UsageEvent } from '../../src/shared/analytics-types';

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'analytics-store-'));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const SESSION = normalizeSession({
  id: 'ses_store',
  title: 'Store session',
  directory: '/repo/demo',
  cost: 0.5,
  tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 1 } },
  time: { created: 1_700_000_000_000, updated: 1_700_000_100_000 },
}) as SessionRecord;

function makeEvent(overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    sessionId: 'ses_store',
    timestamp: 1_700_000_050_000,
    providerID: 'zai',
    modelID: 'glm-5',
    tokens: { input: 4, output: 2, reasoning: 1, cache: { read: 1, write: 0 } },
    cost: 0.1,
    messageCount: 1,
    source: 'assistant',
    estimated: false,
    ...overrides,
  };
}

function pendingRecord(session: SessionRecord = SESSION): StoredSessionAnalytics {
  const snapshot = snapshotEvent(session)!;

  return {
    sessionId: session.sessionId,
    session,
    fingerprint: 'fp-1',
    state: 'pending',
    attempts: 0,
    events: snapshot ? [snapshot] : [],
  };
}

describe('openAnalyticsStore', () => {
  it('initializes an empty store', async () => {
    const store = await openAnalyticsStore(dataDir);

    expect(store.listSessions()).toEqual([]);
    expect(store.nextRevision()).toBe(1);

    await store.close();
  });

  it('records stream counters, reloads them across restarts and clears them on reset', async () => {
    const store = await openAnalyticsStore(dataDir);
    await store.recordCounter({ kind: 'executionFailed', sessionID: 'ses_x', timestamp: 1 });
    await store.recordCounter({ kind: 'permissionWait', sessionID: 'ses_x', timestamp: 2, ms: 4_000 });

    expect(store.listCounters()).toHaveLength(2);
    expect(store.listCounters()[1]?.ms).toBe(4_000);
    await store.close();

    const reopened = await openAnalyticsStore(dataDir);
    expect(reopened.listCounters().map((counter) => counter.kind)).toEqual(['executionFailed', 'permissionWait']);

    await reopened.reset();
    expect(reopened.listCounters()).toEqual([]);

    await reopened.close();
  });

  it('keeps live data when reset cannot replace the persisted files', async () => {
    const store = await openAnalyticsStore(dataDir);
    await store.upsertSession(pendingRecord());
    await chmod(dataDir, 0o500);

    try {
      await expect(store.reset()).rejects.toThrow();
      expect(store.listSessions()).toHaveLength(1);
    } finally {
      await chmod(dataDir, 0o700);
    }

    await store.close();
  });

  it('migrates an existing data directory and store files to owner-only permissions', async () => {
    const store = await openAnalyticsStore(dataDir);
    await store.upsertSession(pendingRecord());
    await store.recordCounter({ kind: 'compaction', sessionID: 'ses_store', timestamp: 1 });
    await store.close();

    await chmod(dataDir, 0o755);

    for (const file of ['manifest.json', 'sessions.jsonl', 'events.jsonl', 'counters.jsonl']) {
      await chmod(join(dataDir, file), 0o644);
    }

    const reopened = await openAnalyticsStore(dataDir);
    expect((await stat(dataDir)).mode & 0o777).toBe(0o700);

    for (const file of ['manifest.json', 'sessions.jsonl', 'events.jsonl', 'counters.jsonl']) {
      expect((await stat(join(dataDir, file))).mode & 0o777).toBe(0o600);
    }

    await reopened.close();
  });

  it('skips malformed counter lines but keeps valid ones', async () => {
    await openAnalyticsStore(dataDir).then((store) => store.close());
    await appendFile(join(dataDir, 'counters.jsonl'), '{"kind":"compaction","sessionID":"ses_x","timestamp":3}\nnot json\n{"kind":"retryScheduled","sessionID":"ses_x"}\n');

    const reopened = await openAnalyticsStore(dataDir);
    expect(reopened.listCounters()).toHaveLength(1);
    expect(reopened.listCounters()[0]?.kind).toBe('compaction');

    await reopened.close();
  });

  it('updates session metadata, bumps revision and keeps the allocation intact', async () => {
    const store = await openAnalyticsStore(dataDir);
    await store.upsertSession(pendingRecord());
    await store.replaceAllocation('ses_store', 'fp-1', {
      state: 'complete',
      events: [makeEvent()],
      attempts: 1,
      syncedAt: 1_700_000_200_000,
    });
    const before = store.listSessions()[0]!;
    const revisionBefore = store.currentRevision();

    await store.updateSessionMetadata({ ...SESSION, title: 'Renamed', outcome: 'succeeded' });

    const after = store.listSessions()[0]!;
    expect(after.session.title).toBe('Renamed');
    expect(after.session.outcome).toBe('succeeded');
    expect(after.fingerprint).toBe(before.fingerprint);
    expect(after.state).toBe('complete');
    expect(after.events).toEqual(before.events);
    expect(store.currentRevision()).toBe(revisionBefore + 1);
    await store.close();

    const reopened = await openAnalyticsStore(dataDir);
    const persisted = reopened.listSessions()[0]!;
    expect(persisted.session.title).toBe('Renamed');
    expect(persisted.session.outcome).toBe('succeeded');
    expect(persisted.state).toBe('complete');

    await reopened.close();
  });

  it('still loads a schema version 1 manifest from earlier releases', async () => {
    const store = await openAnalyticsStore(dataDir);
    await store.upsertSession(pendingRecord());
    await store.close();

    const manifestPath = join(dataDir, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    await (await import('node:fs/promises')).writeFile(manifestPath, JSON.stringify({ ...manifest, schemaVersion: 1 }));

    const reopened = await openAnalyticsStore(dataDir);
    expect(reopened.listSessions()).toHaveLength(1);

    await reopened.close();
  });

  it('appends sessions and reloads them across restarts', async () => {
    const store = await openAnalyticsStore(dataDir);
    const record = pendingRecord();
    await store.upsertSession(record);
    await store.replaceAllocation('ses_store', 'fp-1', {
      state: 'complete',
      events: [makeEvent(), makeEvent({ timestamp: 1_700_000_060_000 })],
      attempts: 1,
      syncedAt: 1_700_000_200_000,
    });
    await store.close();

    const reopened = await openAnalyticsStore(dataDir);
    const sessions = reopened.listSessions();

    expect(sessions).toHaveLength(1);
    const stored = sessions[0]!;
    expect(stored.sessionId).toBe('ses_store');
    expect(stored.state).toBe('complete');
    expect(stored.fingerprint).toBe('fp-1');
    expect(stored.events).toHaveLength(2);
    expect(stored.events[0]?.tokens).toEqual(makeEvent().tokens);
    expect(stored.syncedAt).toBe(1_700_000_200_000);
    expect(reopened.nextRevision()).toBe(1);

    await reopened.close();
  });

  it('replaces allocations atomically instead of appending', async () => {
    const store = await openAnalyticsStore(dataDir);
    await store.upsertSession(pendingRecord());

    store.nextRevision();
    await store.replaceAllocation('ses_store', 'fp-1', { state: 'complete', events: [makeEvent()], attempts: 1 });

    store.nextRevision();
    await store.replaceAllocation('ses_store', 'fp-2', { state: 'complete', events: [makeEvent({ cost: 0.2 })], attempts: 2 });

    const stored = store.listSessions()[0]!;
    expect(stored.fingerprint).toBe('fp-2');
    expect(stored.events).toHaveLength(1);
    expect(stored.events[0]?.cost).toBe(0.2);
    expect(stored.attempts).toBe(2);

    await store.close();

    const reopened = await openAnalyticsStore(dataDir);
    const reloaded = reopened.listSessions()[0]!;
    expect(reloaded.fingerprint).toBe('fp-2');
    expect(reloaded.events).toHaveLength(1);
    await reopened.close();
  });

  it('treats an allocation with a stale fingerprint as pending on reload', async () => {
    const store = await openAnalyticsStore(dataDir);
    await store.upsertSession(pendingRecord());
    await store.replaceAllocation('ses_store', 'fp-1', { state: 'complete', events: [makeEvent()], attempts: 1 });
    await store.close();

    // Simulate a session metadata update that invalidates the allocation:
    // append a newer session line with a different fingerprint.
    const updatedSession = { ...SESSION, timeUpdated: SESSION.timeUpdated + 5_000 };
    const sessionLine = JSON.stringify({
      sessionId: updatedSession.sessionId,
      session: updatedSession,
      fingerprint: 'fp-2',
      state: 'pending',
      attempts: 0,
    });

    await appendFile(join(dataDir, 'sessions.jsonl'), `${sessionLine}\n`, 'utf8');

    const reopened = await openAnalyticsStore(dataDir);
    const stored = reopened.listSessions()[0]!;

    expect(stored.fingerprint).toBe('fp-2');
    expect(stored.state).toBe('pending');
    // Provisional snapshot allocation is available immediately.
    expect(stored.events).toHaveLength(1);
    expect(stored.events[0]?.source).toBe('session-snapshot');

    await reopened.close();
  });

  it('removes sessions and persists deletion', async () => {
    const store = await openAnalyticsStore(dataDir);
    await store.upsertSession(pendingRecord());
    await store.removeSession('ses_store');

    expect(store.listSessions()).toEqual([]);
    await store.close();

    const reopened = await openAnalyticsStore(dataDir);
    expect(reopened.listSessions()).toEqual([]);
    await reopened.close();
  });

  it('resets the store and keeps revisions monotonic', async () => {
    const store = await openAnalyticsStore(dataDir);
    await store.upsertSession(pendingRecord());
    const before = store.nextRevision();
    await store.reset();

    expect(store.listSessions()).toEqual([]);
    expect(store.currentRevision()).toBeGreaterThan(before);
    const afterReset = store.currentRevision();
    await store.close();

    const reopened = await openAnalyticsStore(dataDir);
    expect(reopened.listSessions()).toEqual([]);
    expect(reopened.nextRevision()).toBeGreaterThan(afterReset);
    await reopened.close();
  });

  it('recovers from a truncated final line without losing the next append', async () => {
    const store = await openAnalyticsStore(dataDir);
    await store.upsertSession(pendingRecord());
    await store.close();

    const { appendFileSync } = await import('node:fs');
    const { sessionsPath } = await import('../../src/service/store-files');
    appendFileSync(sessionsPath(dataDir), '{"sessionId":"broken","sess');

    const reopened = await openAnalyticsStore(dataDir);
    await reopened.upsertSession(pendingRecord({ ...SESSION, sessionId: 'ses_next' }));
    await reopened.close();

    const again = await openAnalyticsStore(dataDir);
    expect(again.listSessions().map((entry) => entry.sessionId).sort()).toEqual(['ses_next', 'ses_store']);
    await again.close();
  });

  it('ignores scalar lines and events with invalid usage fields', async () => {
    const store = await openAnalyticsStore(dataDir);
    await store.upsertSession(pendingRecord());
    await store.close();

    const { appendFileSync } = await import('node:fs');
    const { sessionsPath, eventsPath } = await import('../../src/service/store-files');
    appendFileSync(sessionsPath(dataDir), '123\nnull\n');
    appendFileSync(eventsPath(dataDir), '42\n{"sessionId":"ses_store","fingerprint":"fp-1","events":[{"sessionId":"ses_store","timestamp":1}]}\n');

    const reopened = await openAnalyticsStore(dataDir);
    expect(reopened.listSessions().map((entry) => entry.sessionId)).toEqual(['ses_store']);
    expect(reopened.getSession('ses_store')?.sessionId).toBe('ses_store');
    expect(reopened.getSession('missing')).toBeNull();
    await reopened.close();
  });

  it('resolves duplicate final records by taking the last line', async () => {
    const store = await openAnalyticsStore(dataDir);
    await store.upsertSession(pendingRecord());
    await store.close();

    const sessionLine = JSON.stringify({
      sessionId: 'ses_store',
      session: { ...SESSION, title: 'Duplicate newer title' },
      fingerprint: 'fp-1',
      state: 'pending',
      attempts: 0,
    });

    await appendFile(join(dataDir, 'sessions.jsonl'), `${sessionLine}\n`, 'utf8');

    const reopened = await openAnalyticsStore(dataDir);
    const stored = reopened.listSessions()[0]!;
    expect(stored.session.title).toBe('Duplicate newer title');
    await reopened.close();
  });

  it('recovers by ignoring only a truncated final record', async () => {
    const store = await openAnalyticsStore(dataDir);
    await store.upsertSession(pendingRecord());
    await store.close();

    await appendFile(join(dataDir, 'sessions.jsonl'), '{"sessionId":"ses_store","session":{"id":"ses_st', 'utf8');

    const reopened = await openAnalyticsStore(dataDir);
    const sessions = reopened.listSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.session.title).toBe('Store session');
    await reopened.close();
  });

  it('persists the revision counter across restarts', async () => {
    const store = await openAnalyticsStore(dataDir);
    store.nextRevision();
    store.nextRevision();
    await store.close();

    const reopened = await openAnalyticsStore(dataDir);
    expect(reopened.nextRevision()).toBe(3);
    await reopened.close();
  });

  it('stores only numeric analytics and metadata, never content or secrets', async () => {
    const store = await openAnalyticsStore(dataDir);
    await store.upsertSession(pendingRecord());
    await store.replaceAllocation('ses_store', 'fp-1', {
      state: 'complete',
      events: [makeEvent()],
      attempts: 1,
    });
    await store.close();

    const sessionsFile = await readFile(join(dataDir, 'sessions.jsonl'), 'utf8');
    const eventsFile = await readFile(join(dataDir, 'events.jsonl'), 'utf8');
    const manifestFile = await readFile(join(dataDir, 'manifest.json'), 'utf8');
    const everything = `${sessionsFile}${eventsFile}${manifestFile}`;

    // The store never adds conversation content or service credentials of its
    // own; only the record's metadata and numeric fields are allowed.
    expect(everything).not.toContain('"content"');
    expect(everything).not.toContain('OPENCHAMBER_OPENCODE_URL');
    expect(everything).not.toContain('Bearer');
    expect(everything).not.toContain('"parts"');
    expect(everything).not.toContain('"text"');
    expect(everything).toContain('/repo/demo');
    expect(eventsFile).toContain('"input"');
  });

  it('drops tombstoned session allocations on reload', async () => {
    const store = await openAnalyticsStore(dataDir);
    await store.upsertSession(pendingRecord());
    await store.replaceAllocation('ses_store', 'fp-1', { state: 'complete', events: [makeEvent()], attempts: 1 });
    await store.removeSession('ses_store');
    await store.close();

    // Events file still has the allocation lines; the tombstone must win.
    const reopened = await openAnalyticsStore(dataDir);
    expect(reopened.listSessions()).toEqual([]);
    await reopened.close();
  });
});
