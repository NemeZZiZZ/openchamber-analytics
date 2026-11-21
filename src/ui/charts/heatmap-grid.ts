import { createChartTooltip, type ChartTooltip, type TooltipContent } from './chart-tooltip';

export type HeatmapCell = {
  /** Local day key for year-grid cells. */
  day?: string;
  /** 0=Monday … 6=Sunday for rhythm cells. */
  weekday?: number;
  hour?: number;
  /** The local dates this weekday covers ("2 Nov – 9 Nov"); rhythm cells. */
  dates?: string;
  value: number;
  level: 0 | 1 | 2 | 3 | 4;
  /** Accessible/tooltip label including the formatted token value. */
  label: string;
};

export type HeatmapHandle = {
  update(data: HeatmapData): void;
  destroy(): void;
};

export type HeatmapData = {
  cells: HeatmapCell[];
  palette: readonly string[];
  formatValue?: (value: number) => string;
  /** Formats the tooltip title (e.g. day keys → localized dates). */
  formatLabel?: (label: string) => string;
  /** Injectable shared tooltip; a controller is created lazily when omitted. */
  tooltip?: ChartTooltip;
};

const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

// Must match the `.an-heat-cell` size and `.an-heat-grid` gap in styles.css:
// one grid column (a week) is a 10px cell plus a 2px column gap.
const CELL_PX = 10;
const GAP_PX = 2;
const COLUMN_PITCH = CELL_PX + GAP_PX;

function defaultTooltipContent(cell: HeatmapCell, formatValue?: (value: number) => string, formatLabel?: (label: string) => string): TooltipContent {
  const formatted = formatValue ? formatValue(cell.value) : `${cell.value}`;

  if (cell.day !== undefined) {
    const title = formatLabel ? formatLabel(cell.day) : cell.day;
    return { title, rows: [{ label: 'Tokens', value: `${formatted} tokens` }] };
  }

  const weekdayName = WEEKDAY_NAMES[cell.weekday ?? 0] ?? 'Monday';
  const hour = String(cell.hour ?? 0).padStart(2, '0');
  // Rhythm cells aggregate every matching weekday of the window; name the
  // dates they cover so "Wednesday" also says which Wednesdays.
  const title = cell.dates === undefined
    ? `${weekdayName} ${hour}:00`
    : `${weekdayName}, ${cell.dates} · ${hour}:00`;

  return {
    title,
    rows: [{ label: 'Tokens', value: `${formatted} tokens` }],
  };
}

function buildLegend(): HTMLElement {
  const legend = document.createElement('div');
  legend.className = 'an-heat-legend';
  legend.dataset['heatLegend'] = '';

  const less = document.createElement('span');
  less.textContent = 'Less';
  legend.append(less);

  for (let level = 0; level <= 4; level += 1) {
    const swatch = document.createElement('span');
    swatch.className = 'an-heat-cell an-heat-swatch';
    swatch.dataset['level'] = String(level);
    legend.append(swatch);
  }

  const more = document.createElement('span');
  more.textContent = 'More';
  legend.append(more);

  return legend;
}

type HeatCellMap = Map<Element, HeatmapCell>;

/**
 * Shared tooltip wiring for both heatmaps: pointer behavior lives on the grid
 * so crossing the 2px cell gaps never hides the tooltip, while keyboard focus
 * stays on each focusable cell. The handle owns a lazily created tooltip and
 * destroys it; an injected tooltip is left alone.
 */
function wireHeatmapTooltip(
  grid: HTMLElement,
  cellsByElement: HeatCellMap,
  data: HeatmapData,
): { tooltip: ChartTooltip; owned: boolean; detach: () => void } {
  const owned = !data.tooltip;
  const tooltip = data.tooltip ?? createChartTooltip();

  const detach = tooltip.attachPointerTo(grid, (event) => {
    const shape = (event.target as Element | null)?.closest('[data-heat-cell]') ?? null;
    const cell = shape ? cellsByElement.get(shape) : undefined;
    return cell ? defaultTooltipContent(cell, data.formatValue, data.formatLabel) : null;
  });

  for (const [element, cell] of cellsByElement) {
    tooltip.attachKeyboardTo(element, () => defaultTooltipContent(cell, data.formatValue, data.formatLabel));
  }

  return { tooltip, owned, detach };
}

/**
 * The last-12-month activity grid: Monday-first columns via CSS grid
 * `grid-auto-flow: column` with seven rows, month labels absolutely positioned
 * above their month start columns, and the Less→More legend below. Every cell
 * exposes its formatted value and shares the one tooltip implementation.
 */
export function renderYearHeatmap(container: HTMLElement, data: HeatmapData): HeatmapHandle {
  let current: HeatmapData = data;
  let tooltip: ChartTooltip | null = null;
  let ownsTooltip = false;
  let detachPointer: (() => void) | null = null;

  const render = (): void => {
    container.textContent = '';
    tooltip?.hide();
    detachPointer?.();
    detachPointer = null;

    const months = document.createElement('div');
    months.className = 'an-heat-months';
    months.dataset['heatMonths'] = '';

    const grid = document.createElement('div');
    grid.className = 'an-heat-grid an-year-grid';
    grid.dataset['heatGrid'] = '';
    grid.style.gridTemplateRows = 'repeat(7, 1fr)';
    grid.style.gridAutoFlow = 'column';

    const cellsByElement: HeatCellMap = new Map();
    const labels: HTMLSpanElement[] = [];
    let lastMonth = -1;

    for (const cell of current.cells) {
      const cellIndex = cellsByElement.size;
      const element = document.createElement('div');
      element.className = 'an-heat-cell';
      element.dataset['heatCell'] = '';
      element.dataset['level'] = String(cell.level);
      element.tabIndex = 0;
      element.setAttribute('role', 'img');
      element.setAttribute('aria-label', cell.label);
      element.style.gridRow = String((cellIndex % 7) + 1);
      element.style.gridColumn = String(Math.floor(cellIndex / 7) + 1);

      if (cell.day !== undefined) {
        element.dataset['day'] = cell.day;
      }

      cellsByElement.set(element, cell);
      grid.append(element);

      if (cell.day !== undefined) {
        const month = Number(cell.day.slice(5, 7)) - 1;

        if (month !== lastMonth) {
          const label = document.createElement('span');
          label.textContent = MONTH_NAMES[month] ?? '';
          // Sit exactly above the week column where the month starts; the
          // first label starts with the first column.
          label.style.left = `${Math.floor(cellIndex / 7) * COLUMN_PITCH}px`;
          months.append(label);
          labels.push(label);
          lastMonth = month;
        }
      }
    }

    // A month starting within the last two columns would push its label past
    // the grid edge and widen the scrollable area; clamp it to stay inside.
    if (labels.length > 0) {
      const totalColumns = Math.ceil(current.cells.length / 7);
      const maxLeft = Math.max(0, totalColumns * COLUMN_PITCH - 24);
      const last = labels[labels.length - 1]!;
      last.style.left = `${Math.min(Number.parseInt(last.style.left, 10), maxLeft)}px`;
    }

    const wired = wireHeatmapTooltip(grid, cellsByElement, current);
    tooltip = wired.tooltip;
    ownsTooltip = wired.owned;
    detachPointer = wired.detach;

    container.append(months);
    container.append(grid);
    container.append(buildLegend());
  };

  render();

  return {
    update(next) {
      current = next;
      render();
    },
    destroy() {
      container.textContent = '';
      detachPointer?.();
      detachPointer = null;
      if (ownsTooltip) {
        tooltip?.destroy();
      }
      tooltip = null;
    },
  };
}

/**
 * Activity Rhythm: 7 local weekdays × 24 local hours. Every cell label and
 * tooltip carries the weekday, hour, and formatted token value.
 */
export function renderRhythmHeatmap(container: HTMLElement, data: HeatmapData): HeatmapHandle {
  let current: HeatmapData = data;
  let tooltip: ChartTooltip | null = null;
  let ownsTooltip = false;
  let detachPointer: (() => void) | null = null;

  const render = (): void => {
    container.textContent = '';
    tooltip?.hide();
    detachPointer?.();
    detachPointer = null;

    const grid = document.createElement('div');
    grid.className = 'an-heat-grid an-rhythm-grid';
    grid.dataset['heatGrid'] = '';
    grid.style.gridTemplateRows = 'repeat(7, 1fr)';

    const cellsByElement: HeatCellMap = new Map();
    const sorted = [...current.cells].sort(
      (a, b) => (a.weekday ?? 0) - (b.weekday ?? 0) || (a.hour ?? 0) - (b.hour ?? 0),
    );

    for (const cell of sorted) {
      const element = document.createElement('div');
      element.className = 'an-heat-cell';
      element.dataset['heatCell'] = '';
      element.dataset['level'] = String(cell.level);
      element.dataset['weekday'] = String(cell.weekday);
      element.dataset['hour'] = String(cell.hour);
      element.tabIndex = 0;
      element.setAttribute('role', 'img');
      element.setAttribute('aria-label', cell.label);
      element.style.gridRow = String((cell.weekday ?? 0) + 1);
      element.style.gridColumn = String((cell.hour ?? 0) + 1);

      cellsByElement.set(element, cell);
      grid.append(element);
    }

    const wired = wireHeatmapTooltip(grid, cellsByElement, current);
    tooltip = wired.tooltip;
    ownsTooltip = wired.owned;
    detachPointer = wired.detach;

    container.append(grid);
    container.append(buildLegend());
  };

  render();

  return {
    update(next) {
      current = next;
      render();
    },
    destroy() {
      container.textContent = '';
      detachPointer?.();
      detachPointer = null;
      if (ownsTooltip) {
        tooltip?.destroy();
      }
      tooltip = null;
    },
  };
}
