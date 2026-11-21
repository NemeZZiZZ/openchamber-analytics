import { describe, expect, it } from 'vitest';

import { buildActivity, buildActivityRhythm } from '../../src/service/aggregate-activity';
import { createPeriodWindow } from '../../src/service/time';
import type { UsageEvent } from '../../src/shared/analytics-types';

const TZ = 'UTC';
const NOW = Date.parse('2026-11-18T12:00:00Z');
const DAY_MS = 86_400_000;

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

describe('buildActivity', () => {
  it('builds a Monday-first last-12-month grid ending at today', () => {
    const window = createPeriodWindow('30d', NOW, TZ);
    const activity = buildActivity([makeEvent()], NOW, TZ, window);

    expect(activity.cells.length).toBeGreaterThan(350);
    expect(activity.cells.length).toBeLessThan(380);

    const last = activity.cells.at(-1);
    expect(last?.day).toBe('2026-11-18');
    expect(last?.tokens).toBe(21);

    // The grid starts on a Monday (weekday 0 with Monday=0 … Sunday=6).
    const first = activity.cells[0];
    const firstDate = new Date(`${first?.day}T12:00:00Z`);
    expect(firstDate.getUTCDay()).toBe(1);
  });

  it('levels cell intensity relative to the grid maximum', () => {
    const events = [
      makeEvent({ timestamp: NOW }),
      makeEvent({ sessionId: 'ses_big', timestamp: NOW - 2 * DAY_MS, tokens: { input: 40, output: 20, reasoning: 16, cache: { read: 12, write: 4 } } }),
    ];

    const window = createPeriodWindow('30d', NOW, TZ);
    const activity = buildActivity(events, NOW, TZ, window);

    const today = activity.cells.at(-1);
    const big = activity.cells.at(-3);

    // Max cell = 92 tokens → today's 21 tokens: ceil(21/92*4) = 1; 92 → 4.
    expect(today?.level).toBe(1);
    expect(big?.level).toBe(4);
    expect(activity.cells.find((cell) => cell.tokens === 0)?.level).toBe(0);
    expect(activity.longestStreak).toBeGreaterThanOrEqual(1);
  });

  it('computes the longest streak inside the displayed grid', () => {
    const events = [
      makeEvent({ timestamp: NOW }),
      makeEvent({ timestamp: NOW - DAY_MS, sessionId: 'ses_b' }),
      makeEvent({ timestamp: NOW - 2 * DAY_MS, sessionId: 'ses_c' }),
      // A gap, then an older two-day run.
      makeEvent({ timestamp: NOW - 10 * DAY_MS, sessionId: 'ses_d' }),
      makeEvent({ timestamp: NOW - 11 * DAY_MS, sessionId: 'ses_d' }),
    ];

    const window = createPeriodWindow('30d', NOW, TZ);
    const activity = buildActivity(events, NOW, TZ, window);

    expect(activity.longestStreak).toBe(3);
  });

  it('computes period averages from the selected window, not the year grid', () => {
    const window = createPeriodWindow('7d', NOW, TZ);
    const activity = buildActivity([makeEvent()], NOW, TZ, window);

    expect(activity.totalTokens).toBe(21);
    expect(activity.avgTokensPerActiveDay).toBe(21);
    expect(activity.avgTokensPerWeek).toBeCloseTo(21 / Math.ceil(7 / 7), 9);
  });

  it('labels cells with accessible token values', () => {
    const window = createPeriodWindow('30d', NOW, TZ);
    const activity = buildActivity([makeEvent()], NOW, TZ, window);
    const last = activity.cells.at(-1);

    expect(last?.label).toContain('2026-11-18');
    expect(last?.label).toContain('21');
  });
});

describe('buildActivityRhythm', () => {
  it('sums tokens into local weekday × hour cells with levels and labels', () => {
    // 2026-11-18T10:30:00Z is a Wednesday (weekday 2) hour 10 in UTC.
    const instant = Date.parse('2026-11-18T10:30:00Z');
    const window = createPeriodWindow('7d', NOW, TZ);
    const rhythm = buildActivityRhythm([makeEvent({ timestamp: instant })], window, TZ);

    expect(rhythm).toHaveLength(7 * 24);

    const cell = rhythm.find((entry) => entry.weekday === 2 && entry.hour === 10);
    expect(cell?.tokens).toBe(21);
    expect(cell?.level).toBe(4);
    expect(cell?.label).toContain('Wednesday');
    expect(cell?.label).toContain('10');
    expect(cell?.label).toContain('21');

    const empty = rhythm.find((entry) => entry.weekday === 5 && entry.hour === 23);
    expect(empty?.tokens).toBe(0);
    expect(empty?.level).toBe(0);
  });

  it('labels weekday cells with the local dates they cover', () => {
    // Two full weeks: Mondays fall on 2026-11-02 and 2026-11-09.
    const window = {
      startDay: '2026-11-02',
      endDay: '2026-11-15',
      startMs: Date.parse('2026-11-02T00:00:00Z'),
      endMs: Date.parse('2026-11-15T23:59:59.999Z'),
      dayCount: 14,
    };
    const rhythm = buildActivityRhythm([], window, TZ, 'en-GB');

    const monday = rhythm.find((cell) => cell.weekday === 0 && cell.hour === 8);
    expect(monday?.dates).toBe('2 Nov – 9 Nov');
    expect(monday?.label).toContain('2 Nov – 9 Nov');

    const wednesday = rhythm.find((cell) => cell.weekday === 2 && cell.hour === 1);
    expect(wednesday?.dates).toBe('4 Nov – 11 Nov');
  });

  it('levels relative to the largest visible cell', () => {
    const window = createPeriodWindow('7d', NOW, TZ);
    const big = 400;
    const rhythm = buildActivityRhythm(
      [
        makeEvent({ timestamp: Date.parse('2026-11-18T09:00:00Z'), tokens: { input: 4 * big, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
        makeEvent({ timestamp: Date.parse('2026-11-18T09:30:00Z'), sessionId: 'ses_b' }),
        makeEvent({ timestamp: Date.parse('2026-11-17T09:00:00Z'), sessionId: 'ses_c', tokens: { input: 25, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
      ],
      window,
      TZ,
    );

    const max = rhythm.find((entry) => entry.weekday === 2 && entry.hour === 9);
    const mid = rhythm.find((entry) => entry.weekday === 1 && entry.hour === 9);

    expect(max?.tokens).toBe(4 * big + 21);
    expect(max?.level).toBe(4);
    // 25 / max ≈ 0.06 → ceil(0.25) = 1.
    expect(mid?.level).toBe(1);
  });
});
