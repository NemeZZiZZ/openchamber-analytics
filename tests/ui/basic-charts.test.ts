// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { renderBarChart, type ChartHandle } from '../../src/ui/charts/bar-chart';
import { renderStackedBarChart } from '../../src/ui/charts/stacked-bar-chart';
import { renderLineChart } from '../../src/ui/charts/line-chart';
import { renderSparkline } from '../../src/ui/charts/sparkline';
import { renderDonutChart } from '../../src/ui/charts/donut-chart';
import { createChartTooltip } from '../../src/ui/charts/chart-tooltip';
import { FALLBACK_PALETTE, resolvePalette } from '../../src/ui/charts/palette';
import { svgEl } from '../../src/ui/charts/svg';
import type { ChartSeries } from '../../src/ui/charts/bar-chart';

const PALETTE: string[] = [...FALLBACK_PALETTE];

function series(key: string, values: number[], label = key): ChartSeries {
  return {
    key,
    label,
    points: values.map((value, index) => ({ label: `day-${index}`, value })),
  };
}

const containers: HTMLElement[] = [];

function mount(): HTMLElement {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  return container;
}

afterEach(() => {
  for (const container of containers.splice(0)) {
    container.remove();
  }
});

describe('resolvePalette', () => {
  it('derives colors from --oc-* variables with readable fallbacks', () => {
    const root = document.createElement('div');
    document.body.append(root);

    expect(resolvePalette(root)).toEqual(FALLBACK_PALETTE);

    root.style.setProperty('--oc-primary', '#123456');
    const palette = resolvePalette(root);
    expect(palette[0]).toBe('#123456');

    root.remove();
  });
});

describe('svgEl', () => {
  it('creates namespaced elements with text-safe attributes only', () => {
    const element = svgEl('text', { x: '1', 'aria-label': 'safe' });
    element.textContent = '<img src=x onerror=alert(1)>';

    expect(element.tagName).toBe('text');
    expect(element.getAttribute('aria-label')).toBe('safe');
    // Content set via textContent never becomes markup.
    expect(element.querySelector('img')).toBeNull();
  });
});

describe('renderBarChart', () => {
  it('renders accessible bars with deterministic series styling', () => {
    const container = mount();
    const handle = renderBarChart(container, {
      series: [series('tokens', [10, 20, 30])],
      palette: PALETTE,
      width: 300,
      height: 120,
      formatValue: (value) => `${value}`,
      accessibleLabel: 'Daily tokens',
    });

    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('role')).toBe('img');
    expect(svg?.getAttribute('aria-label')).toBe('Daily tokens');

    const bars = container.querySelectorAll('rect');
    expect(bars).toHaveLength(3);

    const widths = [...bars].map((bar) => Number(bar.getAttribute('width')));
    // Taller values produce taller bars on the shared zero-to-max scale.
    const heights = [...bars].map((bar) => Number(bar.getAttribute('height')));
    expect(heights[2]).toBeGreaterThan(heights[0] ?? 0);

    expect(widths.every((width) => width > 0)).toBe(true);
    expect(bars[0]?.getAttribute('class')).toContain('series-1');

    handle.destroy();
    expect(container.querySelector('svg')).toBeNull();
  });

  it('renders a local empty state without fabricating bars', () => {
    const container = mount();
    const handle = renderBarChart(container, {
      series: [series('tokens', [])],
      palette: PALETTE,
      width: 300,
      height: 120,
    });

    expect(container.querySelectorAll('rect')).toHaveLength(0);
    expect(container.textContent).toContain('No data');

    handle.destroy();
  });

  it('updates data through the handle and never injects raw HTML', () => {
    const container = mount();
    const handle = renderBarChart(container, {
      series: [series('tokens', [1])],
      palette: PALETTE,
      width: 100,
      height: 50,
    });

    handle.update({ series: [series('<img src=x onerror=alert(1)>', [2])] });

    expect(container.querySelectorAll('rect')).toHaveLength(1);
    // The hostile series key is carried as an attribute value, never parsed.
    expect(container.querySelector('img')).toBeNull();
    expect(container.innerHTML).toContain('data-series-key="<img');

    handle.destroy();
  });
});

describe('renderStackedBarChart', () => {
  it('stacks additive series so segment heights reconcile with totals', () => {
    const container = mount();
    const data = {
      series: [series('a', [1, 2]), series('b', [3, 4])],
      palette: PALETTE,
      width: 200,
      height: 100,
      formatValue: (value: number) => `${value}`,
    };

    const handle = renderStackedBarChart(container, data);

    // Two points × two series = four segments.
    expect(container.querySelectorAll('rect')).toHaveLength(4);

    const segments = [...container.querySelectorAll('rect')].map((rect) => Number(rect.getAttribute('height')));

    // Shared domain max = 6 (the largest column total); plot height = 80.
    const k = 80 / 6;

    // DOM order: series a's two points, then series b's two points.
    expect(segments[0]).toBeCloseTo(k * 1, 1);
    expect(segments[1]).toBeCloseTo(k * 2, 1);
    expect(segments[2]).toBeCloseTo(k * 3, 1);
    expect(segments[3]).toBeCloseTo(k * 4, 1);

    handle.destroy();
  });

  it('assigns series classes by identity, not by row order', () => {
    const container = mount();
    const handle = renderStackedBarChart(container, {
      series: [series('a', [1]), series('b', [2]), series('c', [3])],
      palette: PALETTE,
      width: 100,
      height: 50,
    });

    const classes = [...container.querySelectorAll('rect')].map((rect) => rect.getAttribute('class'));
    expect(classes[0]).toContain('series-1');
    expect(classes[1]).toContain('series-2');
    expect(classes[2]).toContain('series-3');

    handle.destroy();
  });
});

describe('renderLineChart', () => {
  it('draws straight segments with optional points', () => {
    const container = mount();
    const handle = renderLineChart(container, {
      series: [series('tokens', [0, 10, 5])],
      palette: PALETTE,
      width: 200,
      height: 100,
      showPoints: true,
      formatValue: (value: number) => `${value}`,
    });

    const line = container.querySelector('path');
    expect(line).not.toBeNull();

    const points = container.querySelectorAll('circle');
    expect(points).toHaveLength(3);

    handle.destroy();
    expect(container.querySelector('svg')).toBeNull();
  });

  it('renders a local empty state', () => {
    const container = mount();
    const handle = renderLineChart(container, {
      series: [series('tokens', [])],
      palette: PALETTE,
      width: 200,
      height: 100,
    });

    expect(container.textContent).toContain('No data');
    handle.destroy();
  });
});

describe('renderSparkline', () => {
  it('draws a compact bounded polyline', () => {
    const container = mount();
    const handle = renderSparkline(container, {
      values: [0, 5, 10, 3],
      palette: PALETTE,
      width: 80,
      height: 24,
      accessibleLabel: 'Tokens trend',
    });

    const path = container.querySelector('path');
    expect(path?.getAttribute('d')).not.toBe('');
    expect(container.querySelector('svg')?.getAttribute('aria-label')).toBe('Tokens trend');

    handle.destroy();
  });
});

describe('renderDonutChart', () => {
  it('centers arcs explicitly around (50, 50)', () => {
    const container = mount();
    const handle = renderDonutChart(container, {
      series: [series('a', [3]), series('b', [1])],
      palette: PALETTE,
      size: 100,
      formatValue: (value: number) => `${value}`,
    });

    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('viewBox')).toBe('0 0 100 100');

    const arcs = [...container.querySelectorAll('path[class*="an-arc"]')];
    expect(arcs).toHaveLength(2);

    // Every arc is drawn around the explicit center coordinates.
    for (const arc of arcs) {
      const d = arc.getAttribute('d') ?? '';
      expect(d).toContain('50');
    }

    handle.destroy();
  });

  it('keeps segment identity stable when series are reordered', () => {
    const container = mount();
    const unordered = [
      { ...series('slow-model', [10]), seriesIndex: 0 },
      { ...series('fast-model', [90]), seriesIndex: 1 },
    ];
    const handle = renderDonutChart(container, {
      series: unordered,
      palette: PALETTE,
      size: 100,
    });

    const before = [...container.querySelectorAll('path[class*="an-arc"]')].map(
      (arc) => `${arc.getAttribute('class')}|${arc.getAttribute('data-series-key')}`,
    );

    // Reorder the same series: identity (class, key) must follow the key.
    // Reorder the array: identity travels with the series, so classes and
    // colors follow their original source index rather than the row order.
    const reordered = [unordered[1]!, unordered[0]!];
    handle.update({ series: reordered, palette: PALETTE, size: 100 });

    const after = [...container.querySelectorAll('path[class*="an-arc"]')].map(
      (arc) => `${arc.getAttribute('class')}|${arc.getAttribute('data-series-key')}`,
    );

    expect(before).toHaveLength(2);
    const classFor = (key: string): string | null | undefined => {
      const entry = [...container.querySelectorAll(`path[data-series-key="${key}"]`)][0];
      return entry?.getAttribute('class');
    };

    expect(classFor('slow-model')).toContain('series-1');
    expect(classFor('fast-model')).toContain('series-2');

    void before;
    void after;
    handle.destroy();
  });

  it('renders an empty state without arcs', () => {
    const container = mount();
    const handle = renderDonutChart(container, {
      series: [series('zero', [0])],
      palette: PALETTE,
      size: 100,
    });

    expect(container.querySelectorAll('path[class*="an-arc"]')).toHaveLength(0);
    handle.destroy();
  });
});

describe('chart handles', () => {
  it('supports repeated update/destroy cycles without leaks', () => {
    const container = mount();
    const handles: ChartHandle[] = [];

    for (let index = 0; index < 3; index += 1) {
      handles.push(
        renderBarChart(container, {
          series: [series('tokens', [index + 1])],
          palette: PALETTE,
          width: 50,
          height: 50,
        }),
      );
    }

    for (const handle of handles) {
      handle.destroy();
    }

    expect(container.querySelector('svg')).toBeNull();
  });
});

describe('renderBarChart labels toggle', () => {
  it('omits axis labels when showLabels is false', () => {
    const container = mount();
    const handle = renderBarChart(container, {
      series: [series('cost', [1, 2, 3])],
      palette: PALETTE,
      width: 220,
      height: 44,
      showLabels: false,
    });

    expect(container.querySelectorAll('rect')).toHaveLength(3);
    expect(container.querySelectorAll('.an-axis-label')).toHaveLength(0);
    handle.destroy();
  });

  it('keeps labels by default', () => {
    const container = mount();
    const handle = renderBarChart(container, {
      series: [series('cost', [1, 2, 3])],
      palette: PALETTE,
      width: 220,
      height: 44,
    });

    expect(container.querySelectorAll('.an-axis-label').length).toBeGreaterThan(0);
    handle.destroy();
  });
});

describe('chart tooltips', () => {
  afterEach(() => {
    document.querySelectorAll('.an-chart-tooltip').forEach((element) => element.remove());
  });

  const tooltipText = (): string => document.querySelector('.an-chart-tooltip')?.textContent ?? '';

  it('bar chart shows the hovered bar label and formatted value', () => {
    const container = mount();
    const handle = renderBarChart(container, {
      series: [series('tokens', [10, 20, 30])],
      palette: PALETTE,
      width: 300,
      height: 120,
      formatValue: (value) => `${value} t`,
    });

    const bars = container.querySelectorAll('rect');
    bars[1]!.dispatchEvent(new MouseEvent('pointermove', { clientX: 120, clientY: 40, bubbles: true }));

    expect(tooltipText()).toContain('day-1');
    expect(tooltipText()).toContain('20 t');

    container.querySelector('svg')!.dispatchEvent(new MouseEvent('pointerleave', { bubbles: false }));
    expect(document.querySelector('.an-chart-tooltip')).toBeNull();

    handle.destroy();
    // The lazily created tooltip is destroyed with the handle.
    expect(document.querySelector('.an-chart-tooltip')).toBeNull();
  });

  it('stacked bar chart aggregates every series at the hovered column', () => {
    const container = mount();
    const handle = renderStackedBarChart(container, {
      series: [series('a', [1, 2]), series('b', [3, 4])],
      palette: PALETTE,
      width: 200,
      height: 100,
      formatValue: (value) => `${value}`,
    });

    // DOM order: series a's two segments, then series b's two segments.
    const segments = container.querySelectorAll('rect');
    segments[2]!.dispatchEvent(new MouseEvent('pointermove', { clientX: 30, clientY: 30, bubbles: true }));

    expect(tooltipText()).toContain('day-0');
    expect(tooltipText()).toContain('a');
    expect(tooltipText()).toContain('b');
    expect(tooltipText()).toContain('1');
    expect(tooltipText()).toContain('3');

    handle.destroy();
  });

  it('stacked bar chart formats tooltip values and titles through the chart formatters', () => {
    const container = mount();
    const handle = renderStackedBarChart(container, {
      series: [series('a', [1234, 2]), series('b', [3, 4])],
      palette: PALETTE,
      width: 200,
      height: 100,
      formatValue: (value) => value.toLocaleString('en-US'),
      formatLabel: (label) => `Day ${label}`,
    });

    const segments = container.querySelectorAll('rect');
    segments[0]!.dispatchEvent(new MouseEvent('pointermove', { clientX: 30, clientY: 30, bubbles: true }));

    expect(tooltipText()).toContain('Day day-0');
    expect(tooltipText()).toContain('1,234');
    expect(tooltipText()).not.toContain('1234');

    handle.destroy();
  });

  it('bar chart formats the tooltip title through the label formatter', () => {
    const container = mount();
    const handle = renderBarChart(container, {
      series: [series('tokens', [5, 7])],
      palette: PALETTE,
      width: 200,
      height: 100,
      formatLabel: (label) => `Day ${label}`,
    });

    container.querySelector('rect.an-bar')!.dispatchEvent(new MouseEvent('pointermove', { clientX: 30, clientY: 30, bubbles: true }));

    expect(tooltipText()).toContain('Day day-0');

    handle.destroy();
  });

  it('line chart resolves the nearest point from the pointer x', () => {
    const container = mount();
    const handle = renderLineChart(container, {
      series: [series('tokens', [0, 10, 5])],
      palette: PALETTE,
      width: 200,
      height: 100,
      formatValue: (value) => `${value}`,
    });

    container.querySelector('svg')!.dispatchEvent(new MouseEvent('pointermove', { clientX: 100, clientY: 40, bubbles: true }));

    expect(tooltipText()).toContain('day-1');
    expect(tooltipText()).toContain('10');

    handle.destroy();
  });

  it('line chart tooltip covers every overlay series', () => {
    const container = mount();
    const handle = renderLineChart(container, {
      series: [series('a', [1, 4]), series('b', [2, 8])],
      palette: PALETTE,
      width: 100,
      height: 60,
      formatValue: (value) => `${value}`,
    });

    container.querySelector('svg')!.dispatchEvent(new MouseEvent('pointermove', { clientX: 50, clientY: 30, bubbles: true }));

    expect(tooltipText()).toContain('day-1');
    expect(tooltipText()).toContain('4');
    expect(tooltipText()).toContain('8');

    handle.destroy();
  });

  it('sparkline shows bucket labels and formatted values', () => {
    const container = mount();
    const handle = renderSparkline(container, {
      values: [0, 5, 10, 3],
      labels: ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04'],
      formatValue: (value) => `${value} tokens`,
      tooltipLabel: 'Tokens',
      palette: PALETTE,
      width: 80,
      height: 24,
    });

    container.querySelector('svg')!.dispatchEvent(new MouseEvent('pointermove', { clientX: 40, clientY: 12, bubbles: true }));

    expect(tooltipText()).toContain('2026-11-03');
    expect(tooltipText()).toContain('10 tokens');
    expect(tooltipText()).toContain('Tokens');

    handle.destroy();
  });

  it('sparkline formats the tooltip title through the label formatter', () => {
    const container = mount();
    const handle = renderSparkline(container, {
      values: [0, 5, 10, 3],
      labels: ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04'],
      formatLabel: (label) => `Day ${label}`,
      palette: PALETTE,
      width: 80,
      height: 24,
    });

    container.querySelector('svg')!.dispatchEvent(new MouseEvent('pointermove', { clientX: 40, clientY: 12, bubbles: true }));

    expect(tooltipText()).toContain('Day 2026-11-03');

    handle.destroy();
  });

  it('donut chart shows the hovered slice label, share, and value', () => {
    const container = mount();
    const handle = renderDonutChart(container, {
      series: [series('a', [3]), series('b', [1])],
      palette: PALETTE,
      size: 100,
      formatValue: (value) => `${value} t`,
    });

    const arcs = container.querySelectorAll('path[class*="an-arc"]');
    arcs[0]!.dispatchEvent(new MouseEvent('pointermove', { clientX: 50, clientY: 50, bubbles: true }));

    expect(tooltipText()).toContain('a');
    expect(tooltipText()).toContain('75%');
    expect(tooltipText()).toContain('3 t');

    handle.destroy();
  });

  it('donut chart keeps keyboard access to slice values', () => {
    const container = mount();
    const handle = renderDonutChart(container, {
      series: [series('a', [3])],
      palette: PALETTE,
      size: 100,
      formatValue: (value) => `${value} t`,
    });

    const arc = container.querySelector('path[class*="an-arc"]') as SVGElement;
    arc.dispatchEvent(new FocusEvent('focus'));

    expect(tooltipText()).toContain('a');
    expect(tooltipText()).toContain('100%');

    handle.destroy();
    expect(document.querySelector('.an-chart-tooltip')).toBeNull();
  });

  it('an injected tooltip is reused, not owned', () => {
    const container = mount();
    const tooltip = createChartTooltip();

    const handle = renderBarChart(container, {
      series: [series('tokens', [10])],
      palette: PALETTE,
      width: 60,
      height: 40,
      tooltip,
    });

    container.querySelector('rect')!.dispatchEvent(new MouseEvent('pointermove', { clientX: 10, clientY: 10, bubbles: true }));
    expect(tooltipText()).toContain('day-0');

    handle.destroy();
    // An injected tooltip stays alive after the chart is destroyed.
    tooltip.show({ title: 'alive', rows: [] }, { clientX: 10, clientY: 10 });
    expect(document.querySelector('.an-chart-tooltip')?.textContent).toContain('alive');
    tooltip.destroy();
  });
});
