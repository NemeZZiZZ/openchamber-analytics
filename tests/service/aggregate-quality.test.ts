import { describe, expect, it } from 'vitest';

import type { DailyBucket, UsageEvent } from '../../src/shared/analytics-types';
import { computeBurn, computeQuality } from '../../src/service/aggregate-quality';
import { createPeriodWindow } from '../../src/service/time';

function event(overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    sessionId: 'ses_1',
    timestamp: Date.parse('2026-11-10T10:00:00Z'),
    providerID: 'zai',
    modelID: 'glm',
    tokens: { input: 10, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
    cost: 1,
    messageCount: 1,
    source: 'assistant',
    estimated: false,
    ...overrides,
  };
}

describe('computeQuality', () => {
  it('returns zeros without timed events', () => {
    const quality = computeQuality([event({ source: 'session-snapshot' })]);

    expect(quality.samples).toBe(0);
    expect(quality.errorRate).toBe(0);
    expect(quality.outputTokensPerSecond).toBe(0);
    expect(quality.modelSpeeds).toEqual([]);
  });

  it('computes latency percentiles, streaming speed and rates', () => {
    const events = [
      event({ durationMs: 1000, firstTokenMs: 0, finish: 'stop', hasError: false, toolCalls: 2, toolErrors: 1 }),
      event({ durationMs: 2000, firstTokenMs: 1000, finish: 'length', hasError: false }),
      event({ durationMs: 3000, firstTokenMs: 1000, finish: 'error', hasError: true, retries: 1 }),
      event({ durationMs: 10_000, firstTokenMs: 2000, finish: 'stop', hasError: false }),
    ];
    const quality = computeQuality(events);

    expect(quality.samples).toBe(4);
    expect(quality.medianLatencyMs).toBe(2500);
    expect(quality.p95LatencyMs).toBe(10_000);
    expect(quality.avgFirstTokenMs).toBe(1000);
    // 400 output tokens over 1 + 1 + 2 + 8 = 12 streaming seconds
    expect(quality.outputTokensPerSecond).toBeCloseTo(400 / 12);
    expect(quality.errorRate).toBe(0.25);
    expect(quality.retryRate).toBe(0.25);
    expect(quality.truncatedRate).toBe(0.25);
    expect(quality.toolCalls).toBe(2);
    expect(quality.toolErrorRate).toBe(0.5);
    expect(quality.modelSpeeds).toHaveLength(1);
    expect(quality.modelSpeeds[0]?.modelKey).toBe('zai/glm');
  });

  it('ignores messages without a positive streaming window for speed', () => {
    const quality = computeQuality([event({ durationMs: 500, firstTokenMs: 500 })]);

    expect(quality.samples).toBe(1);
    expect(quality.outputTokensPerSecond).toBe(0);
  });
});

describe('computeBurn', () => {
  const now = Date.parse('2026-11-20T12:00:00Z');
  const window = createPeriodWindow('7d', now, 'UTC');

  function bucket(day: string, tokens: number): DailyBucket {
    return {
      day,
      tokens,
      cost: tokens / 100,
      sessions: 1,
      steps: 1,
      breakdown: { input: tokens, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      models: [],
    };
  }

  it('projects month-end linearly from month-to-date usage', () => {
    const events = [
      event({ timestamp: Date.parse('2026-11-05T10:00:00Z'), cost: 10 }),
      event({ timestamp: Date.parse('2026-11-15T10:00:00Z'), cost: 10 }),
      event({ timestamp: Date.parse('2026-10-30T10:00:00Z'), cost: 99 }),
    ];
    const burn = computeBurn(events, [], window, 'UTC', { tokens: 220, cost: 20 });

    expect(burn.monthToDateCost).toBe(20);
    // 20 over 20 elapsed days × 30 days in November
    expect(burn.projectedMonthCost).toBe(30);
    expect(burn.costPerDay).toBeCloseTo(20 / 7);
  });

  it('flags days far above the robust baseline only with enough history', () => {
    const base = ['01', '02', '03', '04', '05', '06', '07'].map((day, index) => bucket(`2026-11-${day}`, 1000 + index * 10));
    const spiky = [...base, bucket('2026-11-08', 50_000)];

    expect(computeBurn([], base, window, 'UTC', { tokens: 0, cost: 0 }).anomalyDays).toEqual([]);
    expect(computeBurn([], spiky, window, 'UTC', { tokens: 0, cost: 0 }).anomalyDays.map((day) => day.day)).toEqual(['2026-11-08']);
    expect(computeBurn([], spiky.slice(4), window, 'UTC', { tokens: 0, cost: 0 }).anomalyDays).toEqual([]);
  });
});
