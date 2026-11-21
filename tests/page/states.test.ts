// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { buildSnapshot, mountPage, type PageHarness } from '../support/page-harness';

const harnesses: PageHarness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    harness.container.remove();
    document.body.textContent = '';
  }
});

describe('page states', () => {
  it('shows a distinct first-use zero state with an explanation', async () => {
    const harness = await mountPage();
    harnesses.push(harness);

    const state = harness.container.querySelector('[data-page-state]') as HTMLElement;
    expect(state).not.toBeNull();
    expect(state.dataset['stateKind']).toBe('first-zero');
    expect(state.textContent).toContain('OpenCode');
  });

  it('separates an empty filter result from the first-use state', async () => {
    const snapshot = buildSnapshot({
      summary: { ...buildSnapshot().summary, tokens: 0, cost: 0, sessions: 0 },
      coverage: { complete: 12, residual: 0, pending: 0, failed: 0, mismatch: 0, total: 12 },
      daily: buildSnapshot().daily.map((bucket) => ({ ...bucket, tokens: 0, cost: 0, sessions: 0, models: [] })),
      models: [],
      topSessions: [],
      previous: undefined,
    });

    const harness = await mountPage({ snapshot });
    harnesses.push(harness);

    const state = harness.container.querySelector('[data-page-state]') as HTMLElement;
    expect(state.dataset['stateKind']).toBe('no-filter-result');
  });

  it('shows the service-down state when no data ever arrived', async () => {
    const harness = await mountPage({ snapshot: buildSnapshot() });
    harnesses.push(harness);
    harness.bridge.setMode('failure');

    const refresh = harness.container.querySelector('[data-refresh]') as HTMLButtonElement;
    refresh.click();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const state = harness.container.querySelector('[data-page-state]') as HTMLElement;
    expect(state.dataset['stateKind']).toBe('sync-failed');
    // The last good data remains visible on refresh failure.
    expect(harness.container.querySelectorAll('[data-section] h2').length).toBe(8);
  });

  it('keeps section content when a single refresh fails after data arrived', async () => {
    const harness = await mountPage({ snapshot: buildSnapshot() });
    harnesses.push(harness);

    const before = harness.container.querySelector('[data-summary-value]')?.textContent;
    harness.bridge.setMode('failure');

    const refresh = harness.container.querySelector('[data-refresh]') as HTMLButtonElement;
    refresh.click();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(harness.container.querySelector('[data-summary-value]')?.textContent).toBe(before);
    const banner = harness.container.querySelector('[data-sync-error]') as HTMLElement;
    expect(banner?.textContent?.length ?? 0).toBeGreaterThan(0);
  });

  it('renders a visible precision indicator with coverage details', async () => {
    const snapshot = buildSnapshot({
      precision: 'partial',
      periodPrecision: { current: 'partial', previous: 'exact' },
      coverage: { complete: 20, residual: 2, pending: 5, failed: 1, mismatch: 0, mismatch_: 0, total: 30 } as never,
    });

    const harness = await mountPage({ snapshot });
    harnesses.push(harness);

    const indicator = harness.container.querySelector('[data-sync-status]') as HTMLElement;
    expect(indicator.textContent).toContain('Partial');
    expect(indicator.getAttribute('title') ?? '').toContain('pending');
  });
});
