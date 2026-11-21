import type { AnalyticsSnapshot } from '../../shared/analytics-types';
import type { SectionDeps } from '../page-types';
import { formatCompactNumber, formatDayLabel, formatFullNumber, formatUsd } from '../../shared/formatting';
import { renderBarChart } from '../../ui/charts/bar-chart';
import { renderStackedBarChart } from '../../ui/charts/stacked-bar-chart';
import { renderRhythmHeatmap } from '../../ui/charts/heatmap-grid';
import { attachTimeSeriesBrush } from '../../ui/charts/time-series-brush';
import { hostPalette } from '../../ui/charts/palette';
import { createHandleRegistry, type HandleRegistry } from '../page-types';

const BRUSH_THRESHOLD = 30;
const DEFAULT_CHART_WIDTH = 640;

type TrendRegistry = HandleRegistry & { brushes: { update(data: { count: number; identity: string; width?: number }): void }[] };

function newTrendRegistry(): TrendRegistry {
  const registry = createHandleRegistry() as TrendRegistry;
  registry.brushes = [];
  return registry;
}

function dailyChartCard(
  root: HTMLElement,
  key: string,
  title: string,
  series: { key: string; label: string; points: { label: string; value: number }[] }[],
  snapshot: AnalyticsSnapshot,
  kind: 'stacked' | 'bar',
  formatValue: (value: number) => string,
  registries: TrendRegistry[],
): void {
  const card = document.createElement('div');
  card.className = 'an-trend-card';
  card.dataset['trend'] = key;

  const heading = document.createElement('h3');
  heading.textContent = title;
  card.append(heading);

  const chart = document.createElement('div');
  card.append(chart);

  const brushWrap = document.createElement('div');
  brushWrap.className = 'an-brush-wrap';

    const legend = document.createElement('div');
    legend.className = 'an-summary-legend';

    for (const entry of series) {
      const item = document.createElement('span');
      item.className = 'an-legend-item';
      const swatch = document.createElement('span');
      swatch.className = 'an-tooltip-swatch';
      swatch.style.backgroundColor = hostPalette()[series.indexOf(entry) % 6] ?? '';
      item.append(swatch);
      item.append(document.createTextNode(entry.label));
      legend.append(item);
    }

    const renderSlice = (registry: TrendRegistry, startIndex: number, endIndex: number): void => {
    registry.destroyAll();

    const sliced = series.map((entry) => ({ ...entry, points: entry.points.slice(startIndex, endIndex + 1) }));

    if (kind === 'stacked') {
      registry.track(
        renderStackedBarChart(chart, {
          series: sliced,
          palette: hostPalette(),
          width: DEFAULT_CHART_WIDTH,
          height: 160,
          formatValue,
          formatLabel: formatDayLabel,
          accessibleLabel: title,
        }),
      );
    } else {
      registry.track(
        renderBarChart(chart, {
          series: sliced,
          palette: hostPalette(),
          width: DEFAULT_CHART_WIDTH,
          height: 160,
          formatValue,
          formatLabel: formatDayLabel,
          accessibleLabel: title,
        }),
      );
    }
  };

  if (snapshot.daily.length > BRUSH_THRESHOLD) {
    const registry = newTrendRegistry();
    registries.push(registry);

    const brush = attachTimeSeriesBrush({
      container: brushWrap,
      count: snapshot.daily.length,
      width: DEFAULT_CHART_WIDTH,
      identity: `trend:${key}:${snapshot.filters.scope}:${snapshot.filters.range}`,
      onSelectionChange: (selection) => renderSlice(registry, selection.start, selection.end),
    });
    registry.track(brush);
    registry.brushes.push(brush);

    const selection = brush.getSelection();
    renderSlice(registry, selection.start, selection.end);
    card.append(chart, brushWrap, legend);
  } else {
    const registry = newTrendRegistry();
    registries.push(registry);
    renderSlice(registry, 0, Math.max(0, snapshot.daily.length - 1));
    card.append(chart, legend);
  }

  root.append(card);
}

/**
 * Trends: responsive auto-fit grid (target minimum card width 250px) with the
 * token breakdown (all five components, including cache write), prompt
 * caching, sessions per day, cost per day, agent usage ranked by tokens, and
 * the activity rhythm. Daily charts above 30 buckets share the brush.
 */
export function renderTrends(root: HTMLElement, deps: SectionDeps): void {
  root.textContent = '';
  const { snapshot, registry } = deps;
  const registries: TrendRegistry[] = [];
  // Every trend chart, brush and tooltip is torn down with the page registry.
  registry.track({
    destroy: () => {
      for (const entry of registries.splice(0)) {
        entry.destroyAll();
      }
      rhythm?.destroy();
    },
  });
  let rhythm: { destroy(): void } | null = null;

  const grid = document.createElement('div');
  grid.className = 'an-trends-grid';
  root.append(grid);

  // 1. Token breakdown — all five components so stacks reconcile.
  const breakdownSeries = (
    [
      ['input', 'Input'],
      ['output', 'Output'],
      ['reasoning', 'Reasoning'],
      ['cacheRead', 'Cache read'],
      ['cacheWrite', 'Cache write'],
    ] as const
  ).map(([component, label]) => ({
    key: component,
    label,
    points: snapshot.daily.map((bucket) => ({ label: bucket.day, value: bucket.breakdown[component] })),
  }));

  dailyChartCard(grid, 'token-breakdown', 'Token breakdown', breakdownSeries, snapshot, 'stacked', formatFullNumber, registries);

  // 2. Prompt caching: uncached input + cache read (no double subtraction).
  const cachingSeries = [
    { key: 'uncachedInput', label: 'Uncached input', points: snapshot.daily.map((bucket) => ({ label: bucket.day, value: bucket.breakdown.input })) },
    { key: 'cacheRead', label: 'Cache read', points: snapshot.daily.map((bucket) => ({ label: bucket.day, value: bucket.breakdown.cacheRead })) },
  ];
  dailyChartCard(grid, 'prompt-caching', 'Prompt caching', cachingSeries, snapshot, 'stacked', formatFullNumber, registries);

  // 3. Sessions per day.
  const sessionsSeries = [
    { key: 'sessions', label: 'Active sessions', points: snapshot.daily.map((bucket) => ({ label: bucket.day, value: bucket.sessions })) },
  ];
  dailyChartCard(grid, 'sessions-per-day', 'Sessions per day', sessionsSeries, snapshot, 'bar', formatCompactNumber, registries);

  // 4. Cost per day.
  const costSeries = [
    { key: 'cost', label: 'Cost', points: snapshot.daily.map((bucket) => ({ label: bucket.day, value: bucket.cost })) },
  ];
  dailyChartCard(grid, 'cost-per-day', 'Cost per day', costSeries, snapshot, 'bar', formatUsd, registries);

  // 5. Agent usage ranked by tokens.
  const agentCard = document.createElement('div');
  agentCard.className = 'an-trend-card';
  agentCard.dataset['trend'] = 'agents';
  const agentHeading = document.createElement('h3');
  agentHeading.textContent = 'Agent usage';
  agentCard.append(agentHeading);

  const agents = [...snapshot.agents].sort((a, b) => b.tokens - a.tokens || a.agent.localeCompare(b.agent));
  const maxTokens = Math.max(1, ...agents.map((agent) => agent.tokens));

  for (const agent of agents) {
    const row = document.createElement('div');
    row.className = 'an-agent-row';

    const label = document.createElement('span');
    label.textContent = agent.agent;

    const track = document.createElement('div');
    track.className = 'an-agent-track';
    const fill = document.createElement('div');
    fill.className = 'an-agent-fill';
    fill.style.width = `${Math.round((agent.tokens / maxTokens) * 100)}%`;
    track.append(fill);

    const value = document.createElement('span');
    value.className = 'an-agent-value';
    value.textContent = formatCompactNumber(agent.tokens);
    value.title = formatFullNumber(agent.tokens);

    row.append(label, track, value);
    agentCard.append(row);
  }

  if (agents.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'an-chart-empty';
    empty.textContent = 'No agent activity in this period.';
    agentCard.append(empty);
  }

  grid.append(agentCard);

  // 6. Activity Rhythm — weekday × hour with token values in every tooltip.
  const rhythmCard = document.createElement('div');
  rhythmCard.className = 'an-trend-card';
  rhythmCard.dataset['trend'] = 'rhythm';
  const rhythmHeading = document.createElement('h3');
  rhythmHeading.textContent = 'Activity rhythm';
  rhythmCard.append(rhythmHeading);

  const rhythmWrap = document.createElement('div');
  rhythmCard.append(rhythmWrap);
  rhythm = renderRhythmHeatmap(rhythmWrap, {
    cells: snapshot.rhythm.map((cell) => ({
      weekday: cell.weekday,
      hour: cell.hour,
      dates: cell.dates,
      value: cell.tokens,
      level: cell.level,
      label: cell.label,
    })),
    palette: hostPalette(),
    formatValue: formatCompactNumber,
  });

  grid.append(rhythmCard);
}
