import { describe, expect, it } from 'vitest';

import { aggregateSummary, eventModelKey } from '../../src/service/aggregate-core';
import { createPeriodWindow, listLocalDayKeys, localDayKey } from '../../src/service/time';
import type { SessionRecord, UsageEvent } from '../../src/shared/analytics-types';

const TZ = 'UTC';
// 2026-11-18T12:00:00Z
const NOW = Date.parse('2026-11-18T12:00:00Z');

function makeEvent(overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    sessionId: 'ses_a',
    timestamp: NOW,
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

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: 'ses_a',
    title: 'Session',
    directory: '/repo',
    timeCreated: NOW - 3_600_000,
    timeUpdated: NOW,
    tokens: null,
    cost: null,
    ...overrides,
  };
}

describe('eventModelKey', () => {
  it('joins provider and model and falls back to unknown', () => {
    expect(eventModelKey({ ...makeEvent() })).toBe('zai/glm-5');
    expect(eventModelKey({ ...makeEvent(), providerID: undefined })).toBe('unknown/glm-5');
    expect(eventModelKey({ ...makeEvent(), modelID: undefined })).toBe('zai/unknown');
    expect(eventModelKey({ ...makeEvent(), providerID: undefined, modelID: undefined })).toBe('unknown/unknown');
  });

  it('suffixes the variant tier so variants rank as separate models', () => {
    expect(eventModelKey({ ...makeEvent(), variant: 'max' })).toBe('zai/glm-5@max');
    expect(eventModelKey({ ...makeEvent(), variant: undefined })).toBe('zai/glm-5');
  });
});

describe('aggregateSummary', () => {
  it('computes the spec formulas for one event', () => {
    const window = createPeriodWindow('30d', NOW, TZ);
    const summary = aggregateSummary([makeEvent()], window, TZ);

    expect(summary.tokens).toBe(21);
    expect(summary.cost).toBeCloseTo(0.5, 9);
    expect(summary.sessions).toBe(1);
    expect(summary.activeDays).toBe(1);
    expect(summary.cacheHitRate).toBeCloseTo(3 / 13, 9);
    expect(summary.reasoningShare).toBeCloseTo(2 / 21, 9);
    expect(summary.inputTokens).toBe(10);
    expect(summary.outputTokens).toBe(5);
    expect(summary.reasoningTokens).toBe(2);
    expect(summary.cacheReadTokens).toBe(3);
    expect(summary.cacheWriteTokens).toBe(1);
    expect(summary.costPerMillion).toBeCloseTo((0.5 / 21) * 1_000_000, 6);
    expect(summary.costPerSession).toBeCloseTo(0.5, 9);
    expect(summary.tokensPerSession).toBe(21);
    expect(summary.avgTokensPerActiveDay).toBe(21);
  });

  it('counts distinct sessions and active days across events', () => {
    const day = (offsetHours: number): number => NOW - offsetHours * 3_600_000;
    const events = [
      makeEvent({ sessionId: 'ses_a', timestamp: day(1) }),
      makeEvent({ sessionId: 'ses_b', timestamp: day(2) }),
      makeEvent({ sessionId: 'ses_a', timestamp: day(3) }),
      makeEvent({ sessionId: 'ses_c', timestamp: day(24 * 3) }),
    ];

    const window = createPeriodWindow('30d', NOW, TZ);
    const summary = aggregateSummary(events, window, TZ);

    expect(summary.sessions).toBe(3);
    // day(1..3) are the same local day; day(24*3) is an earlier day.
    expect(summary.activeDays).toBe(2);
  });

  it('uses the actual period day count for the weekly average', () => {
    const window = createPeriodWindow('30d', NOW, TZ);
    const summary = aggregateSummary([makeEvent()], window, TZ);

    expect(summary.avgTokensPerWeek).toBeCloseTo(21 / Math.ceil(30 / 7), 9);
  });

  it('does not hardcode 365 days for All time windows beyond a year', () => {
    const earliest = NOW - 400 * 86_400_000;
    const window = createPeriodWindow('all', NOW, TZ, earliest);
    expect(window.dayCount).toBeGreaterThan(400);

    const summary = aggregateSummary([makeEvent()], window, TZ);
    expect(summary.avgTokensPerWeek).toBeCloseTo(21 / Math.ceil(window.dayCount / 7), 9);
  });

  it('computes the current streak over all activity days, not only the window', () => {
    // Today, yesterday, and the day before: three consecutive active local days.
    const events = [
      makeEvent({ timestamp: NOW }),
      makeEvent({ sessionId: 'ses_b', timestamp: NOW - 86_400_000 }),
      makeEvent({ sessionId: 'ses_c', timestamp: NOW - 2 * 86_400_000 }),
    ];

    const window = createPeriodWindow('7d', NOW, TZ);
    const summary = aggregateSummary(events, window, TZ);

    expect(summary.currentStreak).toBe(3);
  });

  it('breaks the streak at the first inactive local day', () => {
    const events = [
      makeEvent({ timestamp: NOW }),
      makeEvent({ sessionId: 'ses_b', timestamp: NOW - 3 * 86_400_000 }),
    ];

    const window = createPeriodWindow('30d', NOW, TZ);
    const summary = aggregateSummary(events, window, TZ);

    expect(summary.currentStreak).toBe(1);
  });

  it('excludes events outside the window bounds from period metrics', () => {
    const window = createPeriodWindow('7d', NOW, TZ);
    const beforeStart = Date.parse('2026-11-01T00:00:00Z');

    const summary = aggregateSummary([makeEvent({ timestamp: beforeStart })], window, TZ);

    expect(summary.tokens).toBe(0);
    expect(summary.sessions).toBe(0);
    expect(summary.activeDays).toBe(0);
    expect(summary.avgTokensPerActiveDay).toBe(0);
    expect(summary.avgTokensPerWeek).toBe(0);
    expect(summary.costPerMillion).toBe(0);
    expect(summary.costPerSession).toBe(0);
    expect(summary.tokensPerSession).toBe(0);
    expect(summary.cacheHitRate).toBe(0);
    expect(summary.reasoningShare).toBe(0);
    expect(summary.currentStreak).toBe(0);
  });

  it('aggregates previous-period windows independently', () => {
    const window = createPeriodWindow('30d', NOW, TZ);
    const previous = window.previous!;
    const prevDayMs = Date.parse(`${previous.startDay}T10:00:00Z`);

    const summary = aggregateSummary([makeEvent({ timestamp: prevDayMs })], previous, TZ);

    expect(summary.tokens).toBe(21);
    expect(summary.activeDays).toBe(1);
    expect(summary.avgTokensPerWeek).toBeCloseTo(21 / Math.ceil(previous.dayCount / 7), 9);
  });

  it('renders every metric as zero on an empty event set', () => {
    const window = createPeriodWindow('30d', NOW, TZ);
    const summary = aggregateSummary([], window, TZ);

    expect(summary.tokens).toBe(0);
    expect(summary.cost).toBe(0);
    expect(summary.sessions).toBe(0);
    expect(summary.prompts).toBe(0);
    expect(summary.subagents).toBe(0);
    expect(summary.activeDays).toBe(0);
    expect(summary.currentStreak).toBe(0);
    expect(summary.inputTokens).toBe(0);
    expect(summary.outputTokens).toBe(0);
    expect(summary.reasoningTokens).toBe(0);
    expect(summary.cacheReadTokens).toBe(0);
    expect(summary.cacheWriteTokens).toBe(0);
  });

  it('counts assistant steps as prompts over the window', () => {
    const events = [
      makeEvent({ messageCount: 4 }),
      makeEvent({ sessionId: 'ses_b', messageCount: 7 }),
      makeEvent({ sessionId: 'ses_c', messageCount: 0, source: 'session-snapshot', estimated: true }),
    ];

    const window = createPeriodWindow('30d', NOW, TZ);
    const summary = aggregateSummary(events, window, TZ);

    expect(summary.prompts).toBe(11);
  });

  it('counts only in-window sessions with a parent as subagents', () => {
    const window = createPeriodWindow('30d', NOW, TZ);
    const beforeStart = Date.parse('2026-09-01T00:00:00Z'); // far outside the 30-day window
    const sessions = [
      makeSession({ sessionId: 'ses_a' }),
      makeSession({ sessionId: 'ses_sub1', parentSessionId: 'ses_a' }),
      makeSession({ sessionId: 'ses_sub2', parentSessionId: 'ses_a' }),
      makeSession({ sessionId: 'ses_sub_out', parentSessionId: 'ses_a' }),
    ];
    const events = [
      makeEvent({ sessionId: 'ses_a' }),
      makeEvent({ sessionId: 'ses_sub1' }),
      makeEvent({ sessionId: 'ses_sub2' }),
      // A subagent session whose only event lies outside the window.
      makeEvent({ sessionId: 'ses_sub_out', timestamp: beforeStart }),
      // A parentless session never counts.
      makeEvent({ sessionId: 'ses_b' }),
    ];

    const summary = aggregateSummary(events, window, TZ, sessions);

    expect(summary.subagents).toBe(2);
    expect(summary.sessions).toBe(4);
  });
});

describe('day key locality', () => {
  it('produces different day buckets for the same UTC events in two timezones', () => {
    // 2026-11-18T02:00:00Z is 2026-11-18 in UTC and 2026-11-18T12:00 in +10; a
    // 16:00Z instant is still Nov 18 in UTC but Nov 19 in UTC+10.
    const instant = Date.parse('2026-11-18T16:00:00Z');

    expect(localDayKey(instant, 'UTC')).toBe('2026-11-18');
    expect(localDayKey(instant, 'Pacific/Kiritimati')).toBe('2026-11-19');

    const keys = listLocalDayKeys('2026-11-18', '2026-11-19', 'Pacific/Kiritimati');
    expect(keys).toEqual(['2026-11-18', '2026-11-19']);
  });
});
