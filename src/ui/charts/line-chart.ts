import { formatLabel } from './bar-chart';
import { linePoints, sharedDomain } from './geometry';
import { seriesClass } from './palette';
import { createChartTooltip, type ChartTooltip } from './chart-tooltip';
import { clearContainer, renderEmptyState, svgEl } from './svg';
import type { ChartHandle, ChartRenderData } from './bar-chart';

function format(value: number, formatter?: (value: number) => string): string {
  return formatter ? formatter(value) : String(Math.round(value * 100) / 100);
}

/**
 * Straight-segment line chart; accepts one series or many for overlays. The
 * pointer resolves to the nearest evenly spaced bucket, so the tooltip covers
 * every series at that bucket even where lines cross.
 */
export function renderLineChart(container: HTMLElement, data: ChartRenderData & { showPoints?: boolean }): ChartHandle {
  let current: ChartRenderData & { showPoints?: boolean } = data;
  let tooltip: ChartTooltip | null = null;
  let ownsTooltip = false;
  let detachPointer: (() => void) | null = null;

  const render = (): void => {
    clearContainer(container);
    tooltip?.hide();
    detachPointer?.();
    detachPointer = null;

    const width = current.width ?? current.size ?? 300;
    const height = current.height ?? current.size ?? 140;
    const allSeries = current.series.length > 0 ? current.series : [];
    const points = allSeries[0]?.points ?? [];

    const svg = svgEl('svg', {
      role: 'img',
      'aria-label': current.accessibleLabel ?? current.series[0]?.label ?? 'line chart',
      viewBox: `0 0 ${width} ${height}`,
      width: String(width),
      height: String(height),
      class: 'an-chart an-line-chart',
    });
    container.append(svg);

    if (points.length === 0) {
      renderEmptyState(container);
      return;
    }

    const domain = sharedDomain(allSeries.map((entry) => entry.points.map((point) => point.value)));
    const plotHeight = height - 20;

    allSeries.forEach((entry, seriesIndex) => {
      const coords = linePoints(entry.points.map((point) => point.value), width, plotHeight, domain);
      const color = entry.color ?? current.palette?.[seriesIndex % (current.palette?.length ?? 1)] ?? '#4c8dff';

      const pathData = coords
        .map((coord, index) => `${index === 0 ? 'M' : 'L'}${coord.x.toFixed(2)},${coord.y.toFixed(2)}`)
        .join(' ');

      svg.append(
        svgEl('path', {
          d: pathData,
          fill: 'none',
          stroke: color,
          'stroke-width': '2',
          'stroke-linejoin': 'round',
          class: `an-line ${seriesClass(entry.seriesIndex ?? seriesIndex)}`,
          'data-series-key': entry.key ?? '',
        }),
      );

      if (current.showPoints) {
        coords.forEach((coord, index) => {
          const point = entry.points[index]!;
          svg.append(
            svgEl('circle', {
              cx: coord.x.toFixed(2),
              cy: coord.y.toFixed(2),
              r: '2.5',
              fill: color,
              class: `an-point ${seriesClass(entry.seriesIndex ?? seriesIndex)}`,
              'data-label': point.label,
              'data-value': (point.value ?? 0).toString(),
              tabindex: '0',
              'aria-label': `${point.label}: ${point.value}`,
            }),
          );
        });
      }
    });

    tooltip = current.tooltip ?? createChartTooltip();
    ownsTooltip = !current.tooltip;
    detachPointer = tooltip.attachPointerTo(svg, (event) => {
      const count = points.length;
      const rect = svg.getBoundingClientRect();
      const span = rect.width || width;
      const index = Math.max(0, Math.min(count - 1, Math.round(((event.clientX - rect.left) / span) * (count - 1))));
      const bucket = points[index];

      if (!bucket) {
        return null;
      }

      return {
        title: formatLabel(bucket.label, current.formatLabel),
        rows: allSeries.map((entry, seriesIndex) => ({
          color: entry.color ?? current.palette?.[seriesIndex % (current.palette?.length ?? 1)] ?? '#4c8dff',
          label: entry.label,
          value: format(entry.points[index]?.value ?? 0, current.formatValue),
        })),
      };
    });
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
