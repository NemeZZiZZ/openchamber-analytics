import { describe, expect, it } from 'vitest';

import { buildDailyBuckets, buildPromptCaching, buildTokenBreakdown, computeEfficiency } from '../../src/service/aggregate-daily';
import { createPeriodWindow } from '../../src/service/time';
import type { SessionRecord, UsageEvent } from '../../src/shared/analytics-types';

const TZ = 'UTC';
const NOW = Date.parse('2026-11-18T12:00:00Z');
const HOUR_MS = 3_600_000;
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

describe('buildDailyBuckets', () => {
  it('fills every local day including zero days', () => {
    const window = createPeriodWindow('7d', NOW, TZ);
    const buckets = buildDailyBuckets([makeEvent()], window, TZ);

    expect(buckets).toHaveLength(7);
    expect(buckets[6]?.day).toBe('2026-11-18');
    expect(buckets[6]?.tokens).toBe(21);
    expect(buckets[0]?.tokens).toBe(0);
    expect(buckets[0]?.sessions).toBe(0);
    expect(buckets[2]?.cost).toBe(0);
  });

  it('separates messages that fall on different local days', () => {
    const window = createPeriodWindow('30d', NOW, TZ);
    const buckets = buildDailyBuckets(
      [
        makeEvent({ timestamp: NOW - DAY_MS }),
        makeEvent({ timestamp: NOW - DAY_MS, sessionId: 'ses_b' }),
        makeEvent({ timestamp: NOW - 3 * DAY_MS, cost: 0.25 }),
      ],
      window,
      TZ,
    );

    const yesterday = buckets[buckets.length - 2];
    const older = buckets[buckets.length - 4];

    expect(yesterday?.tokens).toBe(42);
    expect(yesterday?.sessions).toBe(2);
    expect(older?.tokens).toBe(21);
    expect(older?.cost).toBeCloseTo(0.25, 9);
    expect(buckets[buckets.length - 3]?.tokens).toBe(0);
  });

  it('places a provisional snapshot event at the session update time', () => {
    const updated = NOW - DAY_MS + 3_600_000;

    const snapshot = {
      sessionId: 'ses_snap',
      timestamp: updated,
      tokens: { input: 5, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 2,
      messageCount: 0,
      source: 'session-snapshot' as const,
      estimated: true,
    };

    const window = createPeriodWindow('30d', NOW, TZ);
    const buckets = buildDailyBuckets([snapshot], window, TZ);
    const last = buckets[buckets.length - 2];

    expect(last?.tokens).toBe(10);
    expect(last?.sessions).toBe(1);
    expect(last?.day).toBe('2026-11-17');
  });

  it('buckets per-model allocations for stacked series', () => {
    const window = createPeriodWindow('7d', NOW, TZ);
    const buckets = buildDailyBuckets(
      [
        makeEvent(),
        makeEvent({ sessionId: 'ses_b', modelID: 'glm-6' }),
        makeEvent({ sessionId: 'ses_c', providerID: undefined, modelID: undefined }),
      ],
      window,
      TZ,
    );

    const today = buckets[buckets.length - 1];
    const modelKeys = today?.models.map((model) => model.modelKey);

    expect(modelKeys).toEqual(['unknown/unknown', 'zai/glm-5', 'zai/glm-6']);
    expect(today?.models.find((model) => model.modelKey === 'zai/glm-5')?.tokens).toBe(21);
  });

  it('reconciles bucket token sums with the event totals', () => {
    const window = createPeriodWindow('30d', NOW, TZ);
    const events = [
      makeEvent(),
      makeEvent({ sessionId: 'ses_b', timestamp: NOW - DAY_MS }),
    ];

    const buckets = buildDailyBuckets(events, window, TZ);
    const bucketSum = buckets.reduce((acc, bucket) => acc + bucket.tokens, 0);
    const breakdownSum = buckets.reduce(
      (acc, bucket) => acc + bucket.breakdown.input + bucket.breakdown.output + bucket.breakdown.reasoning + bucket.breakdown.cacheRead + bucket.breakdown.cacheWrite,
      0,
    );

    expect(bucketSum).toBe(42);
    expect(breakdownSum).toBe(42);
  });

  it('is timezone sensitive: the same UTC instant buckets to different days', () => {
    // 2026-11-17T16:00:00Z is 2026-11-17 16:00 in UTC and 2026-11-18 02:00 in
    // Pacific/Kiritimati (+14). Both instants sit inside their own 7d window
    // (NOW = 2026-11-18T12:00Z, which is already Nov 19 in Kiritimati).
    const instant = Date.parse('2026-11-17T16:00:00Z');
    const windowUtc = createPeriodWindow('7d', NOW, 'UTC');
    const windowKir = createPeriodWindow('7d', NOW, 'Pacific/Kiritimati');

    const utcBuckets = buildDailyBuckets([makeEvent({ timestamp: instant })], windowUtc, 'UTC');
    const kirBuckets = buildDailyBuckets([makeEvent({ timestamp: instant })], windowKir, 'Pacific/Kiritimati');

    const utcDay = utcBuckets.find((bucket) => bucket.tokens > 0);
    const kirDay = kirBuckets.find((bucket) => bucket.tokens > 0);

    expect(utcDay?.day).toBe('2026-11-17');
    expect(utcDay?.tokens).toBe(21);
    expect(kirDay?.day).toBe('2026-11-18');
    expect(kirDay?.tokens).toBe(21);
    expect(utcDay?.day).not.toBe(kirDay?.day);
  });
});

describe('steps aggregation', () => {
  it('sums assistant steps per day bucket', () => {
    const window = createPeriodWindow('7d', NOW, TZ);
    const events = [
      makeEvent({ messageCount: 3 }),
      makeEvent({ sessionId: 'ses_b', timestamp: NOW - HOUR_MS, messageCount: 2 }),
      // Provisional snapshots carry no steps.
      makeEvent({ sessionId: 'ses_c', timestamp: NOW - 2 * HOUR_MS, messageCount: 0, source: 'session-snapshot', estimated: true }),
    ];

    const buckets = buildDailyBuckets(events, window, TZ);
    const today = buckets[buckets.length - 1]!;

    expect(today.steps).toBe(5);
    // Other days in the window stay at zero steps.
    expect(buckets[buckets.length - 2]!.steps).toBe(0);
  });

  it('derives steps per session for the window', () => {
    const window = createPeriodWindow('7d', NOW, TZ);
    const efficiency = computeEfficiency(
      [
        makeEvent({ messageCount: 4 }),
        makeEvent({ sessionId: 'ses_b', timestamp: NOW - HOUR_MS, messageCount: 6 }),
      ],
      [],
      window,
      TZ,
    );

    // Two distinct sessions, ten steps.
    expect(efficiency.stepsPerSession).toBeCloseTo(5, 9);
  });
});

describe('buildTokenBreakdown', () => {
  it('exposes all five components so stacked totals reconcile with total tokens', () => {
    const window = createPeriodWindow('7d', NOW, TZ);
    const buckets = buildDailyBuckets([makeEvent()], window, TZ);
    const series = buildTokenBreakdown(buckets);

    expect(series.map((entry) => entry.key)).toEqual(['input', 'output', 'reasoning', 'cacheRead', 'cacheWrite']);

    const lastPoint = (key: string) => series.find((entry) => entry.key === key)?.points.at(-1)?.value;
    expect(lastPoint('input')).toBe(10);
    expect(lastPoint('output')).toBe(5);
    expect(lastPoint('reasoning')).toBe(2);
    expect(lastPoint('cacheRead')).toBe(3);
    expect(lastPoint('cacheWrite')).toBe(1);

    const stackSum = series.reduce((acc, entry) => acc + (entry.points.at(-1)?.value ?? 0), 0);
    expect(stackSum).toBe(21);
  });
});

describe('buildPromptCaching', () => {
  it('uses input plus cache read without subtracting read from input', () => {
    const window = createPeriodWindow('7d', NOW, TZ);
    const buckets = buildDailyBuckets([makeEvent()], window, TZ);
    const series = buildPromptCaching(buckets);

    expect(series.map((entry) => entry.key)).toEqual(['uncachedInput', 'cacheRead']);
    expect(series[0]?.points.at(-1)?.value).toBe(10);
    expect(series[1]?.points.at(-1)?.value).toBe(3);
  });
});

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: 'ses_span',
    title: 'Span session',
    directory: '/repo/demo',
    timeCreated: NOW - 2 * 3_600_000,
    timeUpdated: NOW,
    tokens: null,
    cost: null,
    ...overrides,
  };
}

describe('computeEfficiency', () => {
  it('computes period efficiency from events and session spans', () => {
    const window = createPeriodWindow('30d', NOW, TZ);
    const sessions = [
      makeSession({ sessionId: 'ses_a', timeCreated: NOW - 2 * 3_600_000, timeUpdated: NOW }),
      makeSession({ sessionId: 'ses_b', timeCreated: NOW - 4 * 3_600_000, timeUpdated: NOW - 2 * 3_600_000 }),
    ];

    const efficiency = computeEfficiency(
      [makeEvent(), makeEvent({ sessionId: 'ses_b' })],
      sessions,
      window,
      TZ,
    );

    // Spans: 2h and 2h.
    expect(efficiency.avgSessionSpan).toBe(2 * 3_600_000);
    expect(efficiency.medianSessionSpan).toBe(2 * 3_600_000);
    expect(efficiency.longestSessionSpan).toBe(2 * 3_600_000);
    expect(efficiency.costPerSession).toBeCloseTo(0.5, 9);
    expect(efficiency.tokensPerSession).toBe(21);
    expect(efficiency.costPerMillion).toBeCloseTo((1.0 / 42) * 1_000_000, 6);
    expect(efficiency.reasoningShare).toBeCloseTo(4 / 42, 9);
  });

  it('computes the median over an odd span count', () => {
    const window = createPeriodWindow('30d', NOW, TZ);
    const sessions = [
      makeSession({ sessionId: 'ses_a', timeCreated: NOW - 1 * 3_600_000, timeUpdated: NOW }),
      makeSession({ sessionId: 'ses_b', timeCreated: NOW - 3 * 3_600_000, timeUpdated: NOW - 1 * 3_600_000 }),
      makeSession({ sessionId: 'ses_c', timeCreated: NOW - 9 * 3_600_000, timeUpdated: NOW - 1 * 3_600_000 }),
    ];

    const efficiency = computeEfficiency(
      [makeEvent(), makeEvent({ sessionId: 'ses_b' }), makeEvent({ sessionId: 'ses_c' })],
      sessions,
      window,
      TZ,
    );

    // Sorted spans: 1h, 2h, 8h → median 2h.
    expect(efficiency.medianSessionSpan).toBe(2 * 3_600_000);
    expect(efficiency.avgSessionSpan).toBe((11 / 3) * 3_600_000);
    expect(efficiency.longestSessionSpan).toBe(8 * 3_600_000);
  });

  it('averages the two middle spans over an even span count', () => {
    const window = createPeriodWindow('30d', NOW, TZ);
    const sessions = [
      makeSession({ sessionId: 'ses_a', timeCreated: NOW - 1 * 3_600_000, timeUpdated: NOW }),
      makeSession({ sessionId: 'ses_b', timeCreated: NOW - 2 * 3_600_000, timeUpdated: NOW - 1 * 3_600_000 }),
      makeSession({ sessionId: 'ses_c', timeCreated: NOW - 4 * 3_600_000, timeUpdated: NOW - 1 * 3_600_000 }),
      makeSession({ sessionId: 'ses_d', timeCreated: NOW - 8 * 3_600_000, timeUpdated: NOW - 1 * 3_600_000 }),
    ];

    const efficiency = computeEfficiency(
      [
        makeEvent(),
        makeEvent({ sessionId: 'ses_b' }),
        makeEvent({ sessionId: 'ses_c' }),
        makeEvent({ sessionId: 'ses_d' }),
      ],
      sessions,
      window,
      TZ,
    );

    // Sorted spans: 1h, 1h, 3h, 7h → median (1h + 3h) / 2.
    expect(efficiency.medianSessionSpan).toBe(2 * 3_600_000);
    expect(efficiency.longestSessionSpan).toBe(7 * 3_600_000);
  });

  it('excludes zero, negative, and non-finite spans', () => {
    const window = createPeriodWindow('30d', NOW, TZ);
    const sessions = [
      makeSession({ sessionId: 'ses_a', timeCreated: NOW, timeUpdated: NOW }),
      makeSession({ sessionId: 'ses_b', timeCreated: NOW + 100, timeUpdated: NOW }),
      makeSession({ sessionId: 'ses_c', timeCreated: Number.NaN, timeUpdated: NOW }),
      makeSession({ sessionId: 'ses_d', timeCreated: 0, timeUpdated: Number.POSITIVE_INFINITY }),
      makeSession({ sessionId: 'ses_e', timeCreated: NOW - 3_600_000, timeUpdated: NOW }),
    ];

    const efficiency = computeEfficiency(
      [
        makeEvent(),
        makeEvent({ sessionId: 'ses_b' }),
        makeEvent({ sessionId: 'ses_c' }),
        makeEvent({ sessionId: 'ses_d' }),
        makeEvent({ sessionId: 'ses_e' }),
      ],
      sessions,
      window,
      TZ,
    );

    expect(efficiency.longestSessionSpan).toBe(3_600_000);
    expect(efficiency.avgSessionSpan).toBe(3_600_000);
    expect(efficiency.medianSessionSpan).toBe(3_600_000);
  });

  it('renders zeros when there are no sessions or no usage', () => {
    const window = createPeriodWindow('7d', NOW, TZ);
    const efficiency = computeEfficiency([], [], window, TZ);

    expect(efficiency.costPerMillion).toBe(0);
    expect(efficiency.costPerSession).toBe(0);
    expect(efficiency.tokensPerSession).toBe(0);
    expect(efficiency.reasoningShare).toBe(0);
    expect(efficiency.avgSessionSpan).toBe(0);
    expect(efficiency.medianSessionSpan).toBe(0);
    expect(efficiency.longestSessionSpan).toBe(0);
  });

  it('ignores sessions without events in the window for spans', () => {
    const window = createPeriodWindow('7d', NOW, TZ);
    const unrelated = makeSession({ sessionId: 'ses_other', timeCreated: NOW - 100 * DAY_MS, timeUpdated: NOW - 90 * DAY_MS });

    const efficiency = computeEfficiency([makeEvent()], [unrelated], window, TZ);

    expect(efficiency.longestSessionSpan).toBe(0);
  });
});
