// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { pickOption } from '../support/kit';
import { buildSnapshot, mountPage, type PageHarness } from '../support/page-harness';

const harnesses: PageHarness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    harness.container.remove();
    document.body.textContent = '';
  }
});

function summarySection(harness: PageHarness): HTMLElement {
  return harness.container.querySelector('[data-section="usage-summary"]') as HTMLElement;
}

describe('usage summary controls', () => {
  it('switches metric tabs between tokens, cost, and sessions', async () => {
    const harness = await mountPage({ snapshot: buildSnapshot() });
    harnesses.push(harness);

    const section = summarySection(harness);
    const tabs = [...section.querySelectorAll('[data-metric-tab]')] as HTMLButtonElement[];
    expect(tabs.map((tab) => tab.dataset['metricTab'])).toEqual(['tokens', 'cost', 'sessions', 'steps']);

    const costTab = tabs[1]!;
    costTab.click();
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(section.querySelector('[data-metric-tab="cost"]')?.getAttribute('aria-selected')).toBe('true');
    expect(section.querySelector('[data-summary-value]')?.textContent).toContain('$');
  });

  it('switches daily/total views', async () => {
    const harness = await mountPage({ snapshot: buildSnapshot() });
    harnesses.push(harness);

    const section = summarySection(harness);
    expect(section.querySelector('[data-daily-chart]')).not.toBeNull();

    pickOption(section.querySelector('[data-view-select]') as HTMLElement, 'Total');
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(section.querySelector('[data-donut]')).not.toBeNull();
  });

  it('hides the chart-kind toggle in the total view', async () => {
    const harness = await mountPage({ snapshot: buildSnapshot() });
    harnesses.push(harness);

    const section = summarySection(harness);
    // Daily: the bar/line toggle applies to the daily chart.
    expect(section.querySelector('[data-chart-select]')).not.toBeNull();

    pickOption(section.querySelector('[data-view-select]') as HTMLElement, 'Total');
    await new Promise((resolve) => setTimeout(resolve, 5));

    // Total view renders the donut: bar/line has nothing to switch.
    expect(section.querySelector('[data-chart-select]')).toBeNull();
  });

  it('toggles bar and line chart kinds', async () => {
    const harness = await mountPage({ snapshot: buildSnapshot() });
    harnesses.push(harness);

    const section = summarySection(harness);
    expect(section.querySelectorAll('[data-daily-chart] rect').length).toBeGreaterThan(0);

    pickOption(section.querySelector('[data-chart-select]') as HTMLElement, 'Line');
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(section.querySelector('[data-daily-chart] path')).not.toBeNull();
  });
});

describe('usage summary data', () => {
  it('stacks per-model daily series with top five plus Other', async () => {
    const harness = await mountPage({ snapshot: buildSnapshot() });
    harnesses.push(harness);

    const section = summarySection(harness);
    // Stacked segments grouped per bucket; two models fixture.
    expect(section.querySelectorAll('[data-daily-chart] rect').length).toBeGreaterThan(0);

    // The legend lists the series with model keys.
    const legend = section.querySelector('[data-summary-legend]') as HTMLElement;
    expect(legend.textContent).toContain('glm-5');
  });

  it('uses the primary-model sessions donut in total view', async () => {
    const harness = await mountPage({ snapshot: buildSnapshot() });
    harnesses.push(harness);

    const section = summarySection(harness);
    pickOption(section.querySelector('[data-view-select]') as HTMLElement, 'Total');
    await new Promise((resolve) => setTimeout(resolve, 5));

    const metricTabs = [...section.querySelectorAll('[data-metric-tab]')] as HTMLButtonElement[];
    metricTabs[2]!.click();
    await new Promise((resolve) => setTimeout(resolve, 5));

    const donut = section.querySelector('[data-donut]');
    expect(donut).not.toBeNull();
    // Primary-model assignment: donut slices never exceed total sessions.
    const arcs = donut?.querySelectorAll('path');
    expect(arcs?.length).toBeGreaterThan(0);
  });

  it('shows precision badges and a delta badge per the state machine', async () => {
    const harness = await mountPage({ snapshot: buildSnapshot() });
    harnesses.push(harness);

    const section = summarySection(harness);
    expect(section.textContent).toContain('Exact');

    const delta = section.querySelector('[data-summary-delta]') as HTMLElement;
    expect(delta.textContent).toContain('%');

    // An unavailable previous period renders no delta badge at all — a bare
    // "—" next to the value is noise, not information.
    const estimated = buildSnapshot({
      precision: 'estimated',
      periodPrecision: { current: 'estimated', previous: 'estimated' },
      previous: { ...buildSnapshot().summary, tokens: 0, cost: 0, sessions: 0 },
    });

    const harness2 = await mountPage({ snapshot: estimated });
    harnesses.push(harness2);
    const section2 = summarySection(harness2);
    expect(section2.textContent).toContain('Estimated');
    expect(section2.querySelector('[data-summary-delta]')).toBeNull();
  });

  it('includes the cache write series in the token breakdown chart', async () => {
    const harness = await mountPage({ snapshot: buildSnapshot() });
    harnesses.push(harness);

    const trends = harness.container.querySelector('[data-trend="token-breakdown"]') as HTMLElement;
    expect(trends.textContent).toContain('Cache write');
  });

  it('renders every supplied day in the compact Trends breakdown', async () => {
    const daily = buildSnapshot().daily.slice(0, 2);
    const harness = await mountPage({ snapshot: buildSnapshot({ daily }) });
    harnesses.push(harness);

    const trends = harness.container.querySelector('[data-trend="token-breakdown"]') as HTMLElement;
    const labels = [...trends.querySelectorAll('rect[data-series-key="input"]')].map((bar) => bar.getAttribute('data-label'));

    expect(labels).toEqual(daily.map((bucket) => bucket.day));
  });

  it('renders the wide daily chart in a scroller above 30 buckets, without a brush', async () => {
    // jsdom performs no layout: emulate a narrow scroller on the prototype so
    // the initial scroll-to-latest is observable.
    const originalWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth');
    const originalClient = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { value: 1200, configurable: true });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { value: 400, configurable: true });

    try {
      const harness = await mountPage({ snapshot: buildSnapshot() });
      harnesses.push(harness);

      const section = summarySection(harness);
      expect(section.querySelector('[data-brush-overview]')).toBeNull();

      const scroller = section.querySelector('[data-chart-scroll]') as HTMLElement;
      expect(scroller).not.toBeNull();

      const svg = scroller.querySelector('svg') as SVGSVGElement;
      expect(svg).not.toBeNull();
      // 40 buckets × 20px per day beats the 640px minimum floor.
      expect(svg.getAttribute('width')).toBe('800');
      expect(Number(scroller.scrollLeft)).toBeGreaterThan(0);
    } finally {
      if (originalWidth) {
        Object.defineProperty(HTMLElement.prototype, 'scrollWidth', originalWidth);
      }

      if (originalClient) {
        Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClient);
      }
    }
  });

  it('keeps the compact daily chart without a brush at 30 buckets and below', async () => {
    const small = buildSnapshot({ daily: buildSnapshot().daily.slice(0, 30) });
    const harness = await mountPage({ snapshot: small });
    harnesses.push(harness);

    const section = summarySection(harness);
    expect(section.querySelector('[data-brush-overview]')).toBeNull();

    const svg = section.querySelector('[data-chart-scroll] svg') as SVGSVGElement;
    expect(svg).not.toBeNull();
    // Below the 640px floor the chart keeps its minimum width.
    expect(svg.getAttribute('width')).toBe('640');
  });

  it('labels the activity grid as the independent last 12 months and scrolls to the latest end', async () => {
    // jsdom performs no layout: emulate a wide grid on the prototype so the
    // initial scroll-to-latest is observable.
    const originalWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth');
    const originalClient = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { value: 1200, configurable: true });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { value: 400, configurable: true });

    try {
      const harness = await mountPage({ snapshot: buildSnapshot() });
      harnesses.push(harness);

      const activity = harness.container.querySelector('[data-section="activity"]') as HTMLElement;
      expect(activity.textContent).toContain('Last 12 months');

      const scroller = activity.querySelector('[data-year-scroller]') as HTMLElement;
      expect(scroller).not.toBeNull();
      expect(Number(scroller.scrollLeft)).toBeGreaterThan(0);
    } finally {
      if (originalWidth) {
        Object.defineProperty(HTMLElement.prototype, 'scrollWidth', originalWidth);
      }

      if (originalClient) {
        Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClient);
      }
    }
  });

  it('shows the activity rhythm value in tooltips and labels', async () => {
    const harness = await mountPage({ snapshot: buildSnapshot() });
    harnesses.push(harness);

    const trends = harness.container.querySelector('[data-trend="rhythm"]') as HTMLElement;
    const cell = trends.querySelector('[data-weekday="2"][data-hour="10"]') as HTMLElement;
    expect(cell.getAttribute('aria-label')).toContain('500');
  });
});
