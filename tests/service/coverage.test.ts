import { describe, expect, it } from 'vitest';

import { computeCoverage } from '../../src/service/coverage';
import type { AnalyticsFilters, StoredSessionAnalytics, UsageEvent } from '../../src/shared/analytics-types';

const TZ = 'UTC';
const NOW = Date.parse('2026-11-18T12:00:00Z');
const DAY_MS = 86_400_000;

const PAGE_FILTERS: AnalyticsFilters = {
  scope: 'all',
  range: '30d',
  surface: 'page',
  timeZone: TZ,
};

function makeEvent(overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    sessionId: 'ses_a',
    timestamp: NOW - DAY_MS,
    providerID: 'zai',
    modelID: 'glm-5',
    tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 1 } },
    cost: 0.5,
    messageCount: 1,
    source: 'assistant',
    estimated: false,
    ...overrides,
  };
}

function makeRecord(overrides: Partial<StoredSessionAnalytics> & { sessionId: string }): StoredSessionAnalytics {
  const session = {
    sessionId: overrides.sessionId,
    title: 'Session',
    directory: '/repo/demo',
    timeCreated: NOW - 3 * DAY_MS,
    timeUpdated: NOW - DAY_MS,
    tokens: null,
    cost: null,
  };

  return {
    fingerprint: 'fp',
    state: 'complete',
    attempts: 1,
    events: [makeEvent({ sessionId: overrides.sessionId })],
    syncedAt: NOW,
    session,
    ...overrides,
  };
}

describe('computeCoverage — precision transitions', () => {
  it('treats an authoritatively empty relevant set as exact', () => {
    const result = computeCoverage([], PAGE_FILTERS, 'page', NOW, TZ);

    expect(result.total).toBe(0);
    expect(result.precision).toBe('exact');
    expect(result.periodPrecision.current).toBe('exact');
  });

  it('treats all-complete zero-usage sessions as exact', () => {
    const records = [makeRecord({ sessionId: 'ses_zero', events: [] })];
    const result = computeCoverage(records, PAGE_FILTERS, 'page', NOW, TZ);

    expect(result.complete).toBe(1);
    expect(result.total).toBe(1);
    expect(result.precision).toBe('exact');
  });

  it('stays estimated while no relevant session has assistant events', () => {
    const records = [
      makeRecord({ sessionId: 'ses_p1', state: 'pending', events: [makeEvent({ sessionId: 'ses_p1', source: 'session-snapshot', estimated: true })] }),
      makeRecord({ sessionId: 'ses_p2', state: 'pending', events: [] }),
    ];

    const result = computeCoverage(records, PAGE_FILTERS, 'page', NOW, TZ);

    expect(result.pending).toBe(2);
    expect(result.total).toBe(2);
    expect(result.precision).toBe('estimated');
  });

  it('becomes partial when detailed and pending sessions mix', () => {
    const records = [
      makeRecord({ sessionId: 'ses_complete' }),
      makeRecord({ sessionId: 'ses_pending', state: 'pending', events: [] }),
    ];

    const result = computeCoverage(records, PAGE_FILTERS, 'page', NOW, TZ);

    expect(result.complete).toBe(1);
    expect(result.pending).toBe(1);
    expect(result.precision).toBe('partial');
  });

  it('gates exact on relevant residual allocations', () => {
    const records = [
      makeRecord({
        sessionId: 'ses_residual',
        events: [
          makeEvent({ sessionId: 'ses_residual' }),
          makeEvent({ sessionId: 'ses_residual', source: 'residual', estimated: true, timestamp: NOW - DAY_MS }),
        ],
      }),
    ];

    const result = computeCoverage(records, PAGE_FILTERS, 'page', NOW, TZ);

    expect(result.complete).toBe(1);
    expect(result.residual).toBe(1);
    expect(result.precision).toBe('partial');
  });

  it('keeps failed and mismatch sessions partial', () => {
    const failed = computeCoverage(
      [makeRecord({ sessionId: 'ses_f', state: 'failed', lastError: 'boom', events: [makeEvent({ sessionId: 'ses_f', source: 'session-snapshot', estimated: true })] })],
      PAGE_FILTERS,
      'page',
      NOW,
      TZ,
    );
    expect(failed.failed).toBe(1);
    expect(failed.precision).toBe('estimated');

    const mixed = computeCoverage(
      [
        makeRecord({ sessionId: 'ses_complete' }),
        makeRecord({ sessionId: 'ses_m', state: 'mismatch', events: [makeEvent({ sessionId: 'ses_m', source: 'session-snapshot', estimated: true })] }),
      ],
      PAGE_FILTERS,
      'page',
      NOW,
      TZ,
    );
    expect(mixed.mismatch).toBe(1);
    expect(mixed.precision).toBe('partial');
  });

  it('reaches exact once every relevant session is complete without residual', () => {
    const records = [
      makeRecord({ sessionId: 'ses_1' }),
      makeRecord({ sessionId: 'ses_2' }),
    ];

    const result = computeCoverage(records, PAGE_FILTERS, 'page', NOW, TZ);

    expect(result).toMatchObject({ complete: 2, total: 2, residual: 0, pending: 0, failed: 0, mismatch: 0 });
    expect(result.precision).toBe('exact');
  });

  it('cannot be exact while the session list is still bootstrapping', () => {
    const result = computeCoverage([], PAGE_FILTERS, 'page', NOW, TZ, { sessionListComplete: false });

    expect(result.precision).toBe('estimated');
  });
});

describe('computeCoverage — relevant session windows', () => {
  it('ignores pending sessions outside every represented page window', () => {
    // Active 6 months ago: outside current 30d + previous 30d, inside the page year grid.
    const oldPending = makeRecord({
      sessionId: 'ses_old_pending',
      state: 'pending',
      events: [],
      session: {
        sessionId: 'ses_old_pending',
        title: 'Old',
        directory: '/repo/demo',
        timeCreated: NOW - 180 * DAY_MS,
        timeUpdated: NOW - 170 * DAY_MS,
        tokens: null,
        cost: null,
      },
    });

    const page = computeCoverage([oldPending], PAGE_FILTERS, 'page', NOW, TZ);
    // Page shows the 12-month grid, so the old pending session is relevant.
    expect(page.pending).toBe(1);
    expect(page.precision).not.toBe('exact');
  });

  it('uses the smaller panel relevant set without the year grid', () => {
    const oldPending = makeRecord({
      sessionId: 'ses_old_pending',
      state: 'pending',
      events: [],
      session: {
        sessionId: 'ses_old_pending',
        title: 'Old',
        directory: '/repo/demo',
        timeCreated: NOW - 180 * DAY_MS,
        timeUpdated: NOW - 170 * DAY_MS,
        tokens: null,
        cost: null,
      },
    });

    const panel = computeCoverage([oldPending], { ...PAGE_FILTERS, surface: 'panel' }, 'panel', NOW, TZ);

    // The panel represents only current + previous 30-day windows.
    expect(panel.total).toBe(0);
    expect(panel.precision).toBe('exact');
  });

  it('counts pending sessions inside the current period', () => {
    const recentPending = makeRecord({
      sessionId: 'ses_recent',
      state: 'pending',
      events: [],
      session: {
        sessionId: 'ses_recent',
        title: 'Recent',
        directory: '/repo/demo',
        timeCreated: NOW - 2 * DAY_MS,
        timeUpdated: NOW - DAY_MS,
        tokens: null,
        cost: null,
      },
    });

    const panel = computeCoverage([recentPending], { ...PAGE_FILTERS, surface: 'panel' }, 'panel', NOW, TZ);

    expect(panel.total).toBe(1);
    expect(panel.pending).toBe(1);
    expect(panel.precision).toBe('estimated');
  });

  it('makes every session relevant for All time', () => {
    const ancient = makeRecord({
      sessionId: 'ses_ancient',
      state: 'pending',
      events: [],
      session: {
        sessionId: 'ses_ancient',
        title: 'Ancient',
        directory: '/repo/demo',
        timeCreated: NOW - 800 * DAY_MS,
        timeUpdated: NOW - 790 * DAY_MS,
        tokens: null,
        cost: null,
      },
    });

    const result = computeCoverage([ancient], { ...PAGE_FILTERS, range: 'all' }, 'page', NOW, TZ);

    expect(result.total).toBe(1);
    expect(result.precision).toBe('estimated');
  });

  it('uses detailed event timestamps for complete sessions', () => {
    // Complete session whose events sit inside the current period even though
    // the session record's update time is older.
    const complete = makeRecord({
      sessionId: 'ses_complete',
      events: [makeEvent({ sessionId: 'ses_complete', timestamp: NOW - DAY_MS })],
      session: {
        sessionId: 'ses_complete',
        title: 'Complete',
        directory: '/repo/demo',
        timeCreated: NOW - 200 * DAY_MS,
        timeUpdated: NOW - 150 * DAY_MS,
        tokens: null,
        cost: null,
      },
    });

    const panel = computeCoverage([complete], { ...PAGE_FILTERS, surface: 'panel' }, 'panel', NOW, TZ);

    expect(panel.total).toBe(1);
    expect(panel.complete).toBe(1);
    expect(panel.precision).toBe('exact');
  });

  it('filters by project scope with strict directory equality', () => {
    const other = makeRecord({
      sessionId: 'ses_other',
      session: {
        sessionId: 'ses_other',
        title: 'Other project',
        directory: '/repo/other',
        timeCreated: NOW - 2 * DAY_MS,
        timeUpdated: NOW - DAY_MS,
        tokens: null,
        cost: null,
      },
    });

    const result = computeCoverage(
      [
        makeRecord({
          sessionId: 'ses_mine',
          session: {
            sessionId: 'ses_mine',
            title: 'Mine',
            directory: '/repo/mine',
            timeCreated: NOW - 2 * DAY_MS,
            timeUpdated: NOW - DAY_MS,
            tokens: null,
            cost: null,
          },
        }),
        other,
      ],
      { ...PAGE_FILTERS, scope: 'project', directory: '/repo/mine' },
      'page',
      NOW,
      TZ,
    );

    expect(result.total).toBe(1);
    expect(result.complete).toBe(1);
  });
});

describe('computeCoverage — session list bootstrap and All time', () => {
  it('never reports exact while the session list is still loading', () => {
    const result = computeCoverage([], PAGE_FILTERS, 'page', NOW, TZ, { sessionListComplete: false });

    expect(result.precision).not.toBe('exact');
  });

  it('spans the whole history for the current period precision in All time', () => {
    const old = makeRecord({
      sessionId: 'ses_old',
      state: 'pending',
      events: [],
      session: {
        sessionId: 'ses_old',
        title: 'Old',
        directory: '/repo/demo',
        timeCreated: NOW - 200 * DAY_MS,
        timeUpdated: NOW - 200 * DAY_MS,
        tokens: null,
        cost: null,
      },
    });

    const result = computeCoverage([old], { ...PAGE_FILTERS, range: 'all' }, 'page', NOW, TZ);

    expect(result.precision).not.toBe('exact');
    expect(result.periodPrecision.current).not.toBe('exact');
  });
});
