// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { buildSnapshot, mountPage, type PageHarness } from '../support/page-harness';

const harnesses: PageHarness[] = [];

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    harness.container.remove();
    document.body.textContent = '';
  }
});

function efficiencyText(harness: PageHarness): string {
  return (harness.container.querySelector('[data-section="efficiency"]') as HTMLElement).textContent ?? '';
}

describe('quality and burn cards', () => {
  it('renders latency, speed, error and forecast cards when the service provides them', async () => {
    const harness = await mountPage({
      snapshot: buildSnapshot({
        quality: {
          samples: 10,
          avgLatencyMs: 3000,
          medianLatencyMs: 2500,
          p95LatencyMs: 9000,
          avgFirstTokenMs: 800,
          outputTokensPerSecond: 55,
          finished: 10,
          errorRate: 0.1,
          retryRate: 0.05,
          truncatedRate: 0,
          toolCalls: 20,
          toolErrorRate: 0.25,
          modelSpeeds: [],
        },
        burn: {
          costPerDay: 1.5,
          tokensPerDay: 1000,
          monthToDateCost: 15,
          monthToDateTokens: 10_000,
          projectedMonthCost: 45,
          projectedMonthTokens: 30_000,
          anomalyDays: [{ day: '2026-11-08', tokens: 50_000, cost: 5 }],
        },
      }),
    });
    harnesses.push(harness);

    const text = efficiencyText(harness);

    expect(text).toContain('Median response');
    expect(text).toContain('2.5s');
    expect(text).toContain('Output speed');
    expect(text).toContain('Error rate');
    expect(text).toContain('10%');
    expect(text).toContain('Month forecast');
    expect(text).toContain('Unusual days');
  });

  it('stays quiet for snapshots from older services', async () => {
    const harness = await mountPage({ snapshot: buildSnapshot({ quality: undefined, burn: undefined }) });
    harnesses.push(harness);

    const text = efficiencyText(harness);

    expect(text).not.toContain('Median response');
    expect(text).not.toContain('Month forecast');
  });

  it('renders session outcome and stream counter cards', async () => {
    const harness = await mountPage({
      snapshot: buildSnapshot({
        efficiency: {
          ...buildSnapshot().efficiency,
          failedSessionRate: 0.2,
          failedSessions: 2,
          interruptedSessions: 1,
          sessionsWithOutcome: 10,
        },
        counters: {
          executionFailed: 4,
          executionInterrupted: 2,
          compactions: 6,
          retries: 3,
          permissionAsks: 9,
          avgPermissionWaitMs: 12_000,
          daily: [],
        },
      }),
    });
    harnesses.push(harness);

    const text = efficiencyText(harness);

    expect(text).toContain('Failed sessions');
    expect(text).toContain('20%');
    expect(text).toContain('Stream errors');
    expect(text).toContain('Compactions');
    expect(text).toContain('Avg permission wait');
  });

  it('hides outcome and counter cards when there is nothing to report', async () => {
    const harness = await mountPage({ snapshot: buildSnapshot() });
    harnesses.push(harness);

    const text = efficiencyText(harness);

    expect(text).not.toContain('Failed sessions');
    expect(text).not.toContain('Stream errors');
    expect(text).not.toContain('Compactions');
    expect(text).not.toContain('Avg permission wait');
  });
});
