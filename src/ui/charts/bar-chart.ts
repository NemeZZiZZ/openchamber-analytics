import { capXLabelIndices, numericMax, scaleLinear } from './geometry';
import { seriesClass } from './palette';
import { createChartTooltip, type ChartTooltip } from './chart-tooltip';
import { clearContainer, renderEmptyState, svgEl } from './svg';

export type ChartPoint = { label: string; value: number };

export type ChartSeries = {
  key: string;
  label: string;
  color?: string;
  /** Original series position; sorting must never remap segment identity. */
  seriesIndex?: number;
  points: ChartPoint[];
};

export type ChartHandle = {
  update(data: ChartRenderData): void;
  destroy(): void;
};

export type ChartRenderData = {
  series: ChartSeries[];
  /** Renderers fall back to the bundled palette when omitted. */
  palette?: readonly string[];
  size?: number;
  width?: number;
  height?: number;
  formatValue?: (value: number) => string;
  /** Formats the tooltip title (e.g. day keys → localized dates); labels stay raw otherwise. */
  formatLabel?: (label: string) => string;
  accessibleLabel?: string;
  /** Set false for compact embeds that caption themselves (default true). */
  showLabels?: boolean;
  /** Injectable shared tooltip; a controller is created lazily when omitted. */
  tooltip?: ChartTooltip;
};

function format(value: number, formatter?: (value: number) => string): string {
  return formatter ? formatter(value) : String(Math.round(value * 100) / 100);
}

/** Applies the tooltip-title formatter when provided; raw labels stay raw. */
function formatLabel(label: string, formatter?: (label: string) => string): string {
  return formatter ? formatter(label) : label;
}

export { format, formatLabel };

/** Single-series vertical bar chart on a shared zero-to-max scale. */
export function renderBarChart(container: HTMLElement, data: ChartRenderData): ChartHandle {
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
    const height = current.height ?? current.size ?? 120;
    const points = current.series[0]?.points ?? [];

    const svg = svgEl('svg', {
      role: 'img',
      'aria-label': current.accessibleLabel ?? current.series[0]?.label ?? 'bar chart',
      viewBox: `0 0 ${width} ${height}`,
      width: String(width),
      height: String(height),
      class: 'an-chart an-bar-chart',
    });
    container.append(svg);

    if (points.length === 0) {
      renderEmptyState(container);
      return;
    }

    const domain = { min: 0, max: numericMax(points.map((point) => point.value)) };
    const plotHeight = height - 20;
    const slot = width / points.length;
    const barWidth = Math.max(2, slot * 0.7);
    const color = current.series[0]?.color ?? current.palette?.[0] ?? '#4c8dff';

    points.forEach((point, index) => {
      const barHeight = Math.max(point.value > 0 ? 2 : 0, plotHeight - scaleLinear(point.value, domain, plotHeight));
      const bar = svgEl('rect', {
        x: (index * slot + (slot - barWidth) / 2).toFixed(2),
        y: (plotHeight - barHeight).toFixed(2),
        width: barWidth.toFixed(2),
        height: barHeight.toFixed(2),
        fill: color,
        class: `an-bar ${seriesClass(0)}`,
        'data-series-key': current.series[0]?.key ?? '',
        'data-label': point.label,
        'data-value': format(point.value, current.formatValue),
        'data-point-index': String(index),
      });
      svg.append(bar);
    });

    tooltip = current.tooltip ?? createChartTooltip();
    ownsTooltip = !current.tooltip;
    detachPointer = tooltip.attachPointerTo(svg, (event) => {
      const bar = (event.target as Element | null)?.closest('rect.an-bar');

      if (!bar) {
        return null;
      }

      return {
        title: formatLabel(bar.getAttribute('data-label') ?? '', current.formatLabel),
        rows: [
          {
            color,
            label: current.series[0]?.label ?? '',
            value: bar.getAttribute('data-value') ?? '',
          },
        ],
      };
    });

    // X labels capped at roughly eight positions with start/end context.
    if (current.showLabels === false) {
      return;
    }

    for (const index of capXLabelIndices(points.length)) {
      const point = points[index]!;
      const label = svgEl('text', {
        x: (index * slot + slot / 2).toFixed(2),
        y: String(height - 4),
        'text-anchor': 'middle',
        class: 'an-axis-label',
        'font-size': '9',
      });
      label.textContent = point.label;
      svg.append(label);
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
