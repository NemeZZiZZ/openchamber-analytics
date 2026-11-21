import { donutArcs } from './geometry';
import { seriesClass } from './palette';
import { createChartTooltip, type ChartTooltip } from './chart-tooltip';
import { clearContainer, renderEmptyState, svgEl } from './svg';
import type { ChartHandle, ChartRenderData } from './bar-chart';

const DONUT_CENTER = 50;
const DONUT_OUTER_RADIUS = 44;
const DONUT_INNER_RADIUS = 26;

function arcPath(startAngle: number, endAngle: number): string {
  const sweep = endAngle - startAngle;

  // Split near-full arcs so the large-arc flag stays valid.
  const clampedSweep = Math.min(Math.max(sweep, 0.0001), Math.PI * 2 - 0.0001);
  const end = startAngle + clampedSweep;

  const x1 = DONUT_CENTER + DONUT_OUTER_RADIUS * Math.cos(startAngle);
  const y1 = DONUT_CENTER + DONUT_OUTER_RADIUS * Math.sin(startAngle);
  const x2 = DONUT_CENTER + DONUT_OUTER_RADIUS * Math.cos(end);
  const y2 = DONUT_CENTER + DONUT_OUTER_RADIUS * Math.sin(end);
  const x3 = DONUT_CENTER + DONUT_INNER_RADIUS * Math.cos(end);
  const y3 = DONUT_CENTER + DONUT_INNER_RADIUS * Math.sin(end);
  const x4 = DONUT_CENTER + DONUT_INNER_RADIUS * Math.cos(startAngle);
  const y4 = DONUT_CENTER + DONUT_INNER_RADIUS * Math.sin(startAngle);

  const largeArc = clampedSweep > Math.PI ? 1 : 0;

  return [
    `M ${x1.toFixed(3)} ${y1.toFixed(3)}`,
    `A ${DONUT_OUTER_RADIUS} ${DONUT_OUTER_RADIUS} 0 ${largeArc} 1 ${x2.toFixed(3)} ${y2.toFixed(3)}`,
    `L ${x3.toFixed(3)} ${y3.toFixed(3)}`,
    `A ${DONUT_INNER_RADIUS} ${DONUT_INNER_RADIUS} 0 ${largeArc} 0 ${x4.toFixed(3)} ${y4.toFixed(3)}`,
    'Z',
  ].join(' ');
}

/**
 * Donut chart with explicitly centered arcs around (50, 50) in a 100×100
 * viewBox — no library render-prop defaults. Segment identity (class and
 * data key) follows the series key, so re-sorting models never remaps colors.
 */
export function renderDonutChart(container: HTMLElement, data: ChartRenderData): ChartHandle {
  let current: ChartRenderData = data;
  let tooltip: ChartTooltip | null = null;
  let ownsTooltip = false;
  let detachPointer: (() => void) | null = null;

  const render = (): void => {
    clearContainer(container);
    tooltip?.hide();
    detachPointer?.();
    detachPointer = null;

    const size = current.size ?? 100;
    const series = current.series;

    const svg = svgEl('svg', {
      role: 'img',
      'aria-label': current.accessibleLabel ?? (series.map((entry) => entry.label).join(', ') || 'donut chart'),
      viewBox: '0 0 100 100',
      width: String(size),
      height: String(size),
      class: 'an-chart an-donut-chart',
    });
    container.append(svg);

    const arcs = donutArcs(series.map((entry) => entry.points.reduce((acc, point) => acc + (point.value ?? 0), 0)));

    if (arcs.length === 0) {
      renderEmptyState(container);
      return;
    }

    const total = series.reduce((acc, item) => acc + item.points.reduce((sum, point) => sum + (point.value ?? 0), 0), 0);

    const contentFor = (arc: Element): { title: string; rows: { color?: string; label: string; value: string }[] } | null => {
      const label = arc.getAttribute('data-label');
      const value = arc.getAttribute('data-value');
      const share = arc.getAttribute('data-share');

      if (label === null || value === null || share === null) {
        return null;
      }

      return {
        title: label,
        rows: [
          { color: arc.getAttribute('fill') ?? undefined, label: 'Share', value: `${share}%` },
          { label: 'Value', value },
        ],
      };
    };

    series.forEach((entry, position) => {
      const identity = entry.seriesIndex ?? position;
      const arc = arcs[position];

      if (!arc) {
        return;
      }

      const color = entry.color ?? current.palette?.[identity % (current.palette?.length ?? 1)] ?? '#4c8dff';
      const value = entry.points.reduce((sum, point) => sum + (point.value ?? 0), 0);
      const share = total > 0 ? Math.round((value / total) * 100) : 0;

      svg.append(
        svgEl('path', {
          d: arcPath(arc.startAngle, arc.endAngle),
          fill: color,
          class: `an-arc ${seriesClass(identity)}`,
          'data-series-key': entry.key,
          'data-label': entry.label,
          'data-value': (current.formatValue ?? String)(value),
          'data-share': String(share),
          'aria-label': `${entry.label}: ${share}%`,
          tabindex: '0',
        }),
      );
    });

    tooltip = current.tooltip ?? createChartTooltip();
    ownsTooltip = !current.tooltip;
    detachPointer = tooltip.attachPointerTo(svg, (event) => {
      const arc = (event.target as Element | null)?.closest('path.an-arc');
      return arc ? contentFor(arc) : null;
    });

    for (const arc of svg.querySelectorAll('path.an-arc')) {
      tooltip.attachKeyboardTo(arc, () => contentFor(arc));
    }
  };

  render();

  return {
    update(next) {
      current = next;
      render();
    },
    destroy() {
      clearContainer(container);
      detachPointer?.();
      detachPointer = null;
      if (ownsTooltip) {
        tooltip?.destroy();
      }
      tooltip = null;
    },
  };
}
