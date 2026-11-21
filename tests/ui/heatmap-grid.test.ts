// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { renderYearHeatmap, renderRhythmHeatmap } from '../../src/ui/charts/heatmap-grid';
import { createChartTooltip } from '../../src/ui/charts/chart-tooltip';
import type { HeatmapCell } from '../../src/ui/charts/heatmap-grid';
import { FALLBACK_PALETTE } from '../../src/ui/charts/palette';

const containers: HTMLElement[] = [];
const tooltips: ReturnType<typeof createChartTooltip>[] = [];

afterEach(() => {
  for (const tooltip of tooltips.splice(0)) {
    tooltip.destroy();
  }

  for (const container of containers.splice(0)) {
    container.remove();
  }
});

function mount(): HTMLElement {
  const element = document.createElement('div');
  document.body.append(element);
  containers.push(element);
  return element;
}

function yearCells(): HeatmapCell[] {
  const cells: HeatmapCell[] = [];

  // Three weeks: Mon 2026-11-02 … Sun 2026-11-22, with mixed levels.
  const values = [0, 5, 0, 40, 0, 0, 0, 0, 90, 0, 25, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let index = 0; index < 21; index += 1) {
    const value = values[index] ?? 0;
    const level = value === 0 ? 0 : value >= 90 ? 4 : value >= 40 ? 3 : value >= 25 ? 2 : 1;
    cells.push({
      day: `2026-11-${String(2 + index).padStart(2, '0')}`,
      value,
      level: level as HeatmapCell['level'],
      label: `2026-11-${String(2 + index).padStart(2, '0')}: ${value} tokens`,
    });
  }

  return cells;
}

describe('renderYearHeatmap', () => {
  it('renders a Monday-first grid with all five intensity levels', () => {
    const container = mount();
    const handle = renderYearHeatmap(container, {
      cells: yearCells(),
      palette: [...FALLBACK_PALETTE],
    });

    const grid = container.querySelector('[data-heat-grid]') as HTMLElement;
    expect(grid).not.toBeNull();
    expect(grid.style.gridTemplateRows).toContain('repeat(7');
    expect(grid.style.gridAutoFlow).toBe('column');

    // First cell is Monday 2026-11-02 and opens the first column.
    const firstCell = grid.firstElementChild as HTMLElement;
    expect(firstCell.dataset['day']).toBe('2026-11-02');
    expect(firstCell.style.gridRow).toBe('1');

    // Levels 0–4 appear across the fixture values.
    for (const level of ['0', '1', '2', '3', '4']) {
      expect(grid.querySelectorAll(`[data-level="${level}"]`).length).toBeGreaterThan(0);
    }

    handle.destroy();
    expect(container.querySelector('[data-heat-grid]')).toBeNull();
  });

  it('renders month labels and the Less→More legend', () => {
    const container = mount();
    const handle = renderYearHeatmap(container, {
      cells: yearCells(),
      palette: [...FALLBACK_PALETTE],
    });

    const months = container.querySelector('[data-heat-months]');
    expect(months).not.toBeNull();

    const legend = container.querySelector('[data-heat-legend]') as HTMLElement;
    expect(legend.textContent).toContain('Less');
    expect(legend.textContent).toContain('More');
    expect(legend.querySelectorAll('[data-level]').length).toBe(5);

    handle.destroy();
  });

  it('exposes accessible cell labels including formatted token values', () => {
    const container = mount();
    const handle = renderYearHeatmap(container, {
      cells: yearCells(),
      palette: [...FALLBACK_PALETTE],
    });

    const cell = container.querySelector('[data-day="2026-11-10"]') as HTMLElement;
    expect(cell.getAttribute('aria-label')).toContain('90 tokens');
    expect(cell.getAttribute('tabindex')).toBe('0');

    handle.destroy();
  });

  it('shows the shared tooltip on hover and focus with the formatted value', async () => {
    const container = mount();
    const tooltip = createChartTooltip();
    tooltips.push(tooltip);

    const handle = renderYearHeatmap(container, {
      cells: yearCells(),
      palette: [...FALLBACK_PALETTE],
      tooltip,
    });

    // Pointer handling is bound at the grid level: the move event bubbles
    // from the cell and resolves that cell's content.
    const cell = container.querySelector('[data-day="2026-11-10"]') as HTMLElement;
    cell.dispatchEvent(new MouseEvent('pointermove', { clientX: 10, clientY: 10, bubbles: true }));

    const element = document.querySelector('.an-chart-tooltip') as HTMLElement;
    expect(element).not.toBeNull();
    expect(element.textContent).toContain('90 tokens');

    // Leaving the grid (not a cell) hides the tooltip once.
    const grid = container.querySelector('[data-heat-grid]') as HTMLElement;
    grid.dispatchEvent(new MouseEvent('pointerleave', { bubbles: false }));
    expect(document.querySelector('.an-chart-tooltip')).toBeNull();

    // Keyboard focus still shows the tooltip near the cell.
    cell.dispatchEvent(new FocusEvent('focus'));
    expect(document.querySelector('.an-chart-tooltip')).not.toBeNull();
    cell.dispatchEvent(new FocusEvent('blur'));
    expect(document.querySelector('.an-chart-tooltip')).toBeNull();

    handle.destroy();
  });

  it('formats the year-grid tooltip title through the label formatter', () => {
    const container = mount();
    const handle = renderYearHeatmap(container, {
      cells: yearCells(),
      palette: [...FALLBACK_PALETTE],
      formatLabel: (day) => `Day ${day}`,
    });

    const cell = container.querySelector('[data-day="2026-11-10"]') as HTMLElement;
    cell.dispatchEvent(new MouseEvent('pointermove', { clientX: 10, clientY: 10, bubbles: true }));

    expect((document.querySelector('.an-chart-tooltip') as HTMLElement).textContent).toContain('Day 2026-11-10');

    handle.destroy();
  });

  it('includes the covered dates in the rhythm tooltip title', () => {
    const container = mount();
    const handle = renderRhythmHeatmap(container, {
      cells: [
        { weekday: 2, hour: 10, value: 90, level: 4, label: 'Wednesday, 4 Nov – 11 Nov · 10:00 — 90 tokens', dates: '4 Nov – 11 Nov' },
      ],
      palette: [...FALLBACK_PALETTE],
    });

    const cell = container.querySelector('[data-weekday="2"][data-hour="10"]') as HTMLElement;
    cell.dispatchEvent(new MouseEvent('pointermove', { clientX: 10, clientY: 10, bubbles: true }));

    const element = document.querySelector('.an-chart-tooltip') as HTMLElement;
    expect(element.textContent).toContain('Wednesday, 4 Nov – 11 Nov · 10:00');

    handle.destroy();
  });
});

describe('renderRhythmHeatmap', () => {
  it('renders 7×24 cells with weekday, hour, and formatted token labels', () => {
    const container = mount();

    const names = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const cells: HeatmapCell[] = [];

    for (let weekday = 0; weekday < 7; weekday += 1) {
      for (let hour = 0; hour < 24; hour += 1) {
        const tokens = weekday === 2 && hour === 10 ? 500 : weekday === 1 && hour === 9 ? 90 : 0;
        const level = tokens === 0 ? 0 : tokens >= 400 ? 4 : 1;
        cells.push({
          weekday,
          hour,
          value: tokens,
          level: level as HeatmapCell['level'],
          label: `${names[weekday]} ${String(hour).padStart(2, '0')}:00 — ${tokens} tokens`,
        });
      }
    }

    const handle = renderRhythmHeatmap(container, {
      cells,
      palette: [...FALLBACK_PALETTE],
    });

    const grid = container.querySelector('[data-heat-grid]') as HTMLElement;
    const rendered = grid.querySelectorAll('[data-heat-cell]');
    expect(rendered).toHaveLength(168);

    const peak = grid.querySelector('[data-weekday="2"][data-hour="10"]') as HTMLElement;
    expect(peak.getAttribute('data-level')).toBe('4');
    expect(peak.getAttribute('aria-label')).toContain('Wednesday');
    expect(peak.getAttribute('aria-label')).toContain('10');
    expect(peak.getAttribute('aria-label')).toContain('500');

    handle.destroy();
  });

  it('attaches the shared tooltip with weekday/hour/value content', () => {
    const container = mount();
    const tooltip = createChartTooltip();
    tooltips.push(tooltip);

    const cells: HeatmapCell[] = [];
    for (let weekday = 0; weekday < 7; weekday += 1) {
      for (let hour = 0; hour < 24; hour += 1) {
        cells.push({ weekday, hour, value: 0, level: 0, label: '0 tokens' });
      }
    }

    const handle = renderRhythmHeatmap(container, {
      cells,
      palette: [...FALLBACK_PALETTE],
      tooltip,
    });

    const cell = container.querySelector('[data-weekday="3"][data-hour="15"]') as HTMLElement;
    cell.dispatchEvent(new MouseEvent('pointermove', { clientX: 10, clientY: 10, bubbles: true }));

    const element = document.querySelector('.an-chart-tooltip') as HTMLElement;
    expect(element.textContent).toContain('Thursday');
    expect(element.textContent).toContain('15');

    handle.destroy();
  });
});

describe('year heatmap month labels', () => {
  it('positions each month label above its month start column', async () => {
    const container = mount();

    // Five full weeks (35 days) spanning two months: 3 weeks Nov, 2 weeks Dec.
    const cells: HeatmapCell[] = [];
    for (let index = 0; index < 35; index += 1) {
      const day = index < 21 ? `2026-11-${String(2 + index).padStart(2, '0')}` : `2026-12-${String(index - 21 + 1).padStart(2, '0')}`;
      cells.push({ day, value: 0, level: 0, label: `${day}: 0 tokens` });
    }

    const handle = renderYearHeatmap(container, { cells, palette: [...FALLBACK_PALETTE] });
    const labels = [...container.querySelectorAll('[data-heat-months] span')] as HTMLElement[];

    expect(labels).toHaveLength(2);
    // Labels sit at the column where each month starts: one column is a
    // 10px cell plus a 2px gap, so 3 week-columns offset Dec by 36px.
    expect(labels[0]?.style.left).toBe('0px');
    expect(labels[1]?.style.left).toBe('36px');

    handle.destroy();
  });

  it('keeps the label row from widening the scrollable area', async () => {
    const container = mount();

    // A full 371-day grid: 53 week-columns, 12 months of labels.
    const cells: HeatmapCell[] = [];
    for (let index = 0; index < 371; index += 1) {
      const date = new Date(Date.UTC(2025, 10, 2 + index));
      const day = date.toISOString().slice(0, 10);
      cells.push({ day, value: 0, level: 0, label: `${day}: 0 tokens` });
    }

    const handle = renderYearHeatmap(container, { cells, palette: [...FALLBACK_PALETTE] });

    // The last label is clamped so it cannot extend past the grid columns.
    const labels = [...container.querySelectorAll('[data-heat-months] span')] as HTMLElement[];
    const lastLabel = labels[labels.length - 1]!;
    expect(Number.parseFloat(lastLabel.style.left)).toBeLessThanOrEqual(53 * 12 - 24);

    handle.destroy();
  });
});
