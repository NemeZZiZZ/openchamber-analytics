import { linePoints, sharedDomain } from './geometry';
import { createChartTooltip, type ChartTooltip } from './chart-tooltip';
import { clearContainer, svgEl } from './svg';

export type SparklineData = {
  values: number[];
  palette: readonly string[];
  width?: number;
  height?: number;
  color?: string;
  accessibleLabel?: string;
  /** Bucket labels aligned with `values` (e.g. day keys) for the tooltip. */
  labels?: string[];
  /** Formats a value for the tooltip row. */
  formatValue?: (value: number) => string;
  /** Formats the tooltip title (e.g. day keys → localized dates). */
  formatLabel?: (label: string) => string;
  /** Tooltip row label, e.g. the metric name ("Tokens"). */
  tooltipLabel?: string;
  /** Injectable shared tooltip; a controller is created lazily when omitted. */
  tooltip?: ChartTooltip;
};

export type SparklineHandle = {
  update(data: SparklineData): void;
  destroy(): void;
};

/** Compact no-axis line for KPI cards; stays inside its bounds. */
export function renderSparkline(container: HTMLElement, data: SparklineData): SparklineHandle {
  let current: SparklineData = data;
  let tooltip: ChartTooltip | null = null;
  let ownsTooltip = false;
  let detachPointer: (() => void) | null = null;

  const render = (): void => {
    clearContainer(container);
    tooltip?.hide();
    detachPointer?.();
    detachPointer = null;

    const width = current.width ?? 80;
    const height = current.height ?? 24;
    const values = current.values;

    const svg = svgEl('svg', {
      role: 'img',
      'aria-label': current.accessibleLabel ?? 'sparkline',
      viewBox: `0 0 ${width} ${height}`,
      width: String(width),
      height: String(height),
      class: 'an-chart an-sparkline',
    });
    container.append(svg);

    if (values.length === 0) {
      return;
    }

    const domain = sharedDomain([values]);
    const coords = linePoints(values, width, height, domain);
    const pathData = coords
      .map((coord, index) => `${index === 0 ? 'M' : 'L'}${coord.x.toFixed(2)},${Math.max(0.5, Math.min(height - 0.5, coord.y)).toFixed(2)}`)
      .join(' ');

    svg.append(
      svgEl('path', {
        d: pathData,
        fill: 'none',
        stroke: current.color ?? current.palette?.[0] ?? '#4c8dff',
        'stroke-width': '1.5',
        'stroke-linejoin': 'round',
        class: 'an-sparkline-path',
      }),
    );

    tooltip = current.tooltip ?? createChartTooltip();
    ownsTooltip = !current.tooltip;
    detachPointer = tooltip.attachPointerTo(svg, (event) => {
      const rect = svg.getBoundingClientRect();
      const index = nearestIndex(event.clientX - rect.left, rect.width || width, values.length);
      const value = values[index] ?? 0;
      const label = current.labels?.[index];

      if (label === undefined) {
        return null;
      }

      return {
        title: current.formatLabel ? current.formatLabel(label) : label,
        rows: [
          {
            label: current.tooltipLabel ?? 'Value',
            value: current.formatValue ? current.formatValue(value) : `${value}`,
          },
        ],
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

/** Evenly spaced points: map a local pointer x back to the nearest bucket. */
function nearestIndex(localX: number, span: number, count: number): number {
  if (count <= 1 || span <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(count - 1, Math.round((localX / span) * (count - 1))));
}
