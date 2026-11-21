import { describe, expect, it } from 'vitest';

import { listProjects } from '../../src/service/aggregate-projects';
import type { StoredSessionAnalytics, UsageEvent } from '../../src/shared/analytics-types';

const NOW = Date.parse('2026-11-18T12:00:00Z');
const DAY_MS = 86_400_000;

function makeEvent(sessionId: string, overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    sessionId,
    timestamp: NOW - DAY_MS,
    tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
    cost: 0.5,
    messageCount: 1,
    source: 'assistant',
    estimated: false,
    ...overrides,
  };
}

function makeRecord(sessionId: string, directory: string, events: UsageEvent[] = []): StoredSessionAnalytics {
  return {
    sessionId,
    session: {
      sessionId,
      title: `Session ${sessionId}`,
      directory,
      timeCreated: NOW - 2 * DAY_MS,
      timeUpdated: NOW - DAY_MS,
      tokens: null,
      cost: null,
    },
    fingerprint: 'fp',
    state: 'complete',
    attempts: 1,
    syncedAt: NOW,
    events,
  };
}

describe('listProjects', () => {
  it('groups sessions by normalized directory and sums all-time tokens and cost', () => {
    const records = [
      makeRecord('ses_1', '/repo/demo', [makeEvent('ses_1', { cost: 0.5 }), makeEvent('ses_1', { cost: 0.25 })]),
      makeRecord('ses_2', '/repo/demo/', [makeEvent('ses_2', { cost: 1 })]),
      makeRecord('ses_3', '\\repo\\other', [makeEvent('ses_3', { cost: 2 })]),
    ];

    expect(listProjects(records)).toEqual([
      { directory: '/repo/demo', label: 'demo', sessions: 2, tokens: 45, cost: 1.75 },
      { directory: '/repo/other', label: 'other', sessions: 1, tokens: 15, cost: 2 },
    ]);
  });

  it('skips records without a directory', () => {
    const records = [makeRecord('ses_1', ''), makeRecord('ses_2', '/repo/demo')];

    expect(listProjects(records)).toEqual([
      { directory: '/repo/demo', label: 'demo', sessions: 1, tokens: 0, cost: 0 },
    ]);
  });

  it('sorts by tokens descending with a label tie-break', () => {
    const records = [
      makeRecord('ses_b', '/repo/beta'),
      makeRecord('ses_a', '/repo/alpha'),
      makeRecord('ses_c', '/repo/gamma', [makeEvent('ses_c')]),
    ];

    expect(listProjects(records).map((project) => project.label)).toEqual(['gamma', 'alpha', 'beta']);
  });
});
