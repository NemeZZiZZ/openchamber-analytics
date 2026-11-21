import { format, formatLabel } from './bar-chart';
import { numericMax, stackSeries } from './geometry';
import { seriesClass } from './palette';
import { createChartTooltip, type ChartTooltip } from './chart-tooltip';
import { clearContainer, renderEmptyState, svgEl } from './svg';
import type { ChartHandle, ChartRenderData } from './bar-chart';

/**
 * Additive multi-series stacked bars on one shared zero-to-max scale. Segment
 * identity travels with the series key, never with the sorted row order.
 */
export function renderStackedBarChart(container: HTMLElement, data: ChartRenderData): ChartHandle {
  let current: ChartRenderData = data;
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
    const series = current.series;
    const pointCount = series.reduce((acc, entry) => Math.max(acc, entry.points.length), 0);

    const svg = svgEl('svg', {
      role: 'img',
      'aria-label': current.accessibleLabel ?? (series.map((entry) => entry.label).join(', ') || 'stacked bar chart'),
      viewBox: `0 0 ${width} ${height}`,
      width: String(width),
      height: String(height),
      class: 'an-chart an-stacked-bar-chart',
    });
    container.append(svg);

    if (pointCount === 0 || series.length === 0) {
      renderEmptyState(container);
      return;
    }

    const stacked = stackSeries(series.map((entry) => ({ key: entry.key, points: entry.points.map((point) => point.value) })));
    const domain = { min: 0, max: numericMax(stacked.totals) };
    const plotHeight = height - 20;
    const slot = width / pointCount;
    const barWidth = Math.max(2, slot * 0.7);

    series.forEach((entry, position) => {
      const identity = entry.seriesIndex ?? position;
      const color = entry.color ?? current.palette?.[identity % (current.palette?.length ?? 1)] ?? '#4c8dff';
      const tops = stacked.tops[position]!;
      const bases = stacked.bases[position]!;

      const k = plotHeight / domain.max;

      entry.points.forEach((point, pointIndex) => {
        const top = tops[pointIndex] ?? 0;
        const base = bases[pointIndex] ?? 0;
        const yTop = plotHeight - k * top;
        const yBase = plotHeight - k * base;
        const segmentHeight = Math.max(0, yBase - yTop);

        if (segmentHeight <= 0) {
          return;
        }

        const rect = svgEl('rect', {
          x: (pointIndex * slot + (slot - barWidth) / 2).toFixed(2),
          y: yTop.toFixed(2),
          width: barWidth.toFixed(2),
          height: segmentHeight.toFixed(2),
          fill: color,
          class: `an-segment ${seriesClass(identity)}`,
          'data-series-key': entry.key,
          'data-label': point.label,
          'data-value': format(point.value ?? 0, current.formatValue),
          'data-point-index': String(pointIndex),
        });
        svg.append(rect);
      });
    });

    tooltip = current.tooltip ?? createChartTooltip();
    ownsTooltip = !current.tooltip;
    detachPointer = tooltip.attachPointerTo(svg, (event) => {
      const segment = (event.target as Element | null)?.closest('rect.an-segment');

      if (!segment) {
        return null;
      }

      // One row per series present in the hovered column, in series order.
      const pointIndex = segment.getAttribute('data-point-index');
      const label = segment.getAttribute('data-label') ?? '';
      const segments = [...svg.querySelectorAll('rect.an-segment')];
      const rows = [];

      for (const entry of series) {
        const rowSegment = segments.find(
          (element) =>
            element.getAttribute('data-point-index') === pointIndex &&
            element.getAttribute('data-series-key') === entry.key,
        );

        if (!rowSegment) {
          continue;
        }

        rows.push({
          color: rowSegment.getAttribute('fill') ?? undefined,
          label: entry.label,
          value: rowSegment.getAttribute('data-value') ?? '',
        });
      }

      return { title: formatLabel(label, current.formatLabel), rows };
    });
  };

  const handle: ChartHandle = {
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

  render();
  return handle;
}
