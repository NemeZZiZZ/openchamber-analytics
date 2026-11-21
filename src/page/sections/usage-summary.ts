import type { AnalyticsSnapshot } from '../../shared/analytics-types';
import type { ChartHandle, ChartSeries } from '../../ui/charts/bar-chart';
import { computeDelta, deltaPercentLabel } from '../../shared/delta';
import { formatCompactNumber, formatDayLabel, formatFullNumber, formatUsd } from '../../shared/formatting';
import { createPrecisionBadge } from '../../ui/sync-status';
import { createSelectControl, createTabsControl } from '../../ui/controls';
import { renderBarChart } from '../../ui/charts/bar-chart';
import { renderStackedBarChart } from '../../ui/charts/stacked-bar-chart';
import { renderLineChart } from '../../ui/charts/line-chart';
import { renderDonutChart } from '../../ui/charts/donut-chart';
import { scrollToLatest } from '../../ui/charts/chart-shell';
import { hostPalette } from '../../ui/charts/palette';
import { modelDisplayName, isReasoningModel, type HandleRegistry, type PageUiState } from '../page-types';

const DEFAULT_CHART_WIDTH = 640;
/** Pixels of horizontal room per daily bucket once the range overflows. */
const PER_DAY_PX = 20;

type MetricMap = { tokens: number; cost: number; sessions: number; prompts: number };

function metricValue(map: MetricMap, metric: PageUiState['metric']): number {
  if (metric === 'cost') {
    return map.cost;
  }

  if (metric === 'sessions') {
    return map.sessions;
  }

  if (metric === 'steps') {
    return map.prompts;
  }

  return map.tokens;
}

function formatMetric(value: number, metric: PageUiState['metric']): string {
  if (metric === 'cost') {
    return formatUsd(value);
  }

  return formatCompactNumber(value);
}

function formatMetricFull(value: number, metric: PageUiState['metric']): string {
  if (metric === 'cost') {
    return formatUsd(value);
  }

  return formatFullNumber(value);
}

const METRIC_LABELS: Record<PageUiState['metric'], string> = {
  tokens: 'Tokens',
  cost: 'Cost',
  sessions: 'Sessions',
  steps: 'Steps',
};

/**
 * Per-model daily series: top five model keys by the selected metric plus an
 * Other aggregate. Series identity follows the stable model rank, so colors
 * never remap between renders.
 */
export function dailyModelSeries(
  snapshot: AnalyticsSnapshot,
  metric: PageUiState['metric'],
): ChartSeries[] {
  const buckets = snapshot.daily;
  const palette: string[] = hostPalette();

  if (metric === 'sessions') {
    return [
      {
        key: 'sessions',
        label: 'Active sessions',
        color: palette[0],
        seriesIndex: 0,
        points: buckets.map((bucket) => ({ label: bucket.day, value: bucket.sessions })),
      },
    ];
  }

  if (metric === 'steps') {
    return [
      {
        key: 'steps',
        label: 'Model steps',
        color: palette[0],
        seriesIndex: 0,
        points: buckets.map((bucket) => ({ label: bucket.day, value: bucket.steps })),
      },
    ];
  }

  const totals = new Map<string, { tokens: number; cost: number; providerID?: string; modelID?: string }>();

  for (const bucket of buckets) {
    for (const model of bucket.models) {
      const entry = totals.get(model.modelKey) ?? { tokens: 0, cost: 0 };
      entry.tokens += model.tokens;
      entry.cost += model.cost;

      if (!totals.has(model.modelKey)) {
        const aggregate = snapshot.models.find((candidate) => candidate.modelKey === model.modelKey);
        entry.providerID = aggregate?.providerID;
        entry.modelID = aggregate?.modelID;
      }

      totals.set(model.modelKey, entry);
    }
  }

  const ranked = [...totals.entries()]
    .map(([key, value]) => ({
      key,
      metricValue: metric === 'cost' ? value.cost : value.tokens,
      tokens: value.tokens,
      cost: value.cost,
      providerID: value.providerID,
      modelID: value.modelID,
    }))
    .sort((a, b) => b.metricValue - a.metricValue || a.key.localeCompare(b.key));

  const topKeys = ranked.slice(0, 5).map((entry) => entry.key);
  const otherKeys = ranked.slice(5).map((entry) => entry.key);

  const series: ChartSeries[] = topKeys.map((key, index) => {
    const meta = totals.get(key)!;
    const aggregate = snapshot.models.find((candidate) => candidate.modelKey === key);

    return {
      key,
      label: modelDisplayName(meta.providerID, meta.modelID, key),
      color: palette[index % palette.length],
      seriesIndex: index,
      points: buckets.map((bucket) => ({
        label: bucket.day,
        value: bucket.models.find((model) => model.modelKey === key)?.[metric === 'cost' ? 'cost' : 'tokens'] ?? 0,
      })),
      ...(aggregate ? {} : {}),
    };
  });

  if (otherKeys.length > 0) {
    series.push({
      key: '__other__',
      label: `Other (${otherKeys.length})`,
      color: palette[5 % palette.length],
      seriesIndex: 5,
      points: buckets.map((bucket) => ({
        label: bucket.day,
        value: bucket.models
          .filter((model) => otherKeys.includes(model.modelKey))
          .reduce((acc, model) => acc + (metric === 'cost' ? model.cost : model.tokens), 0),
      })),
    });
  }

  return series;
}

/**
 * Usage Summary: metric tabs, daily/total views, bar/line toggle, the big
 * current-period value with the previous-period delta, precision badge, the
 * full-range daily chart in a horizontal scroller, and the total-view donut
 * (primary-model assignment for Sessions).
 */
export function renderUsageSummary(
  root: HTMLElement,
  deps: {
    snapshot: AnalyticsSnapshot;
    ui: PageUiState;
    registry: HandleRegistry;
    actions: {
      setMetric: (metric: PageUiState['metric']) => void;
      setView: (view: PageUiState['view']) => void;
      setChart: (chart: PageUiState['chart']) => void;
    };
  },
): void {
  root.textContent = '';
  const { snapshot, ui, registry } = deps;

  const controls = document.createElement('div');
  controls.className = 'an-summary-controls';

  const tabs = createTabsControl({
    options: (['tokens', 'cost', 'sessions', 'steps'] as const).map((metric) => ({ value: metric, label: METRIC_LABELS[metric] })),
    value: ui.metric,
    ariaLabel: 'Main metric',
    onChange: (value) => deps.actions.setMetric(value as PageUiState['metric']),
  });
  tabs.element.dataset['metricTabs'] = '';
  for (const button of tabs.element.querySelectorAll<HTMLElement>('.oc-sdk-tab')) {
    button.dataset['metricTab'] = button.dataset['id'] ?? '';
  }
  registry.track({ destroy: () => tabs.handle.dispose() });
  controls.append(tabs.element);

  const viewSelect = createSelectControl({
    options: [
      { value: 'daily', label: 'Daily' },
      { value: 'total', label: 'Total' },
    ],
    value: ui.view,
    ariaLabel: 'Summary view',
    onChange: (value) => deps.actions.setView(value as PageUiState['view']),
  });
  viewSelect.element.dataset['viewSelect'] = '';
  registry.track({ destroy: () => viewSelect.handle.dispose() });
  controls.append(viewSelect.element);

  // The bar/line toggle only switches the daily chart; the total view renders
  // the donut and hides it (as it already does for the sessions metric).
  if (ui.view === 'daily' && ui.metric !== 'sessions') {
    const chartSelect = createSelectControl({
      options: [
        { value: 'bar', label: 'Bar' },
        { value: 'line', label: 'Line' },
      ],
      value: ui.chart,
      ariaLabel: 'Chart type',
      onChange: (value) => deps.actions.setChart(value as PageUiState['chart']),
    });
    chartSelect.element.dataset['chartSelect'] = '';
    registry.track({ destroy: () => chartSelect.handle.dispose() });
    controls.append(chartSelect.element);
  }

  root.append(controls);

  // Big current value + previous delta + precision badge.
  const headline = document.createElement('div');
  headline.className = 'an-summary-headline';

  const value = document.createElement('span');
  value.className = 'an-summary-value';
  value.dataset['summaryValue'] = '';
  const current = metricValue(snapshot.summary, ui.metric);
  value.textContent = formatMetric(current, ui.metric);
  value.setAttribute('aria-label', `${METRIC_LABELS[ui.metric]}: ${formatMetricFull(current, ui.metric)}`);

  const previous = snapshot.previous;
  const delta = computeDelta(
    current,
    previous ? metricValue(previous, ui.metric) : undefined,
    snapshot.periodPrecision.previous,
  );

  // An unavailable previous period renders no badge at all: a bare "—" next
  // to the value is noise, not information (all time, provisional zero, …).
  if (delta.state !== 'unavailable') {
    const deltaBadge = document.createElement('span');
    deltaBadge.className = `an-delta an-delta-${delta.state}`;
    deltaBadge.dataset['summaryDelta'] = '';
    deltaBadge.textContent = deltaPercentLabel(delta);
    headline.append(deltaBadge);
  }

  const precisionBadge = createPrecisionBadge(snapshot.precision, snapshot.coverage);
  precisionBadge.dataset['precisionBadge'] = '';

  headline.append(value, precisionBadge);
  root.append(headline);

  const chartArea = document.createElement('div');
  chartArea.className = 'an-summary-chart';
  root.append(chartArea);

  if (ui.view === 'total') {
    const donutWrap = document.createElement('div');
    donutWrap.className = 'an-summary-donut';
    donutWrap.dataset['donut'] = '';

    // Sessions use the primary-model assignment so slices never exceed the
    // total distinct session count; tokens/cost are additive model sums.
    const source = ui.metric === 'sessions' ? snapshot.sessionDonut : snapshot.models;
    const ranked = [...source]
      .filter((model) => metricValue({ tokens: model.tokens, cost: model.cost, sessions: model.sessions, prompts: model.steps }, ui.metric) > 0)
      .sort((a, b) =>
        metricValue({ tokens: b.tokens, cost: b.cost, sessions: b.sessions, prompts: b.steps }, ui.metric) -
        metricValue({ tokens: a.tokens, cost: a.cost, sessions: a.sessions, prompts: a.steps }, ui.metric),
      );

    const top = ranked.slice(0, 5);
    const rest = ranked.slice(5);

    const series = top.map((model, index) => ({
      key: model.modelKey,
      label: modelDisplayName(model.providerID, model.modelID, model.modelKey),
      color: hostPalette()[index % 6],
      seriesIndex: index,
      points: [{ label: model.modelKey, value: metricValue({ tokens: model.tokens, cost: model.cost, sessions: model.sessions, prompts: model.steps }, ui.metric) }],
    }));

    if (rest.length > 0) {
      series.push({
        key: '__other__',
        label: `Other (${rest.length})`,
        color: hostPalette()[5 % 6],
        seriesIndex: 5,
        points: [{
          label: 'other',
          value: rest.reduce((acc, model) => acc + metricValue({ tokens: model.tokens, cost: model.cost, sessions: model.sessions, prompts: model.steps }, ui.metric), 0),
        }],
      });
    }

    registry.track(
      renderDonutChart(donutWrap, {
        series,
        palette: hostPalette(),
        size: 180,
        formatValue: (value) => formatMetricFull(value, ui.metric),
        accessibleLabel: `${METRIC_LABELS[ui.metric]} by model`,
      }),
    );

    const legend = document.createElement('div');
    legend.className = 'an-summary-legend';
    legend.dataset['summaryLegend'] = '';

    for (const entry of series) {
      const item = document.createElement('span');
      item.className = 'an-legend-item';
      const swatch = document.createElement('span');
      swatch.className = 'an-tooltip-swatch';
      swatch.style.backgroundColor = entry.color ?? '';
      item.append(swatch);
      item.append(document.createTextNode(entry.label));
      legend.append(item);
    }

    donutWrap.append(legend);
    chartArea.append(donutWrap);
    return;
  }

  // Daily view: the full-range chart lives in a horizontal scroller. Its
  // width is at least the container (short ranges look unchanged) and 20px
  // per bucket when that is wider, opening at the most recent end.
  const series = dailyModelSeries(snapshot, ui.metric);
  const chartScroll = document.createElement('div');
  chartScroll.className = 'an-chart-scroll';
  chartScroll.dataset['chartScroll'] = '';
  chartArea.append(chartScroll);

  const dailyChart = document.createElement('div');
  dailyChart.className = 'an-daily-chart';
  dailyChart.dataset['dailyChart'] = '';
  chartScroll.append(dailyChart);

  const formatChartValue = (value: number): string => formatMetricFull(value, ui.metric);
  const renderDaily = (width: number): ChartHandle => {
    if (ui.metric === 'sessions') {
      // Sessions per day: one series of distinct active sessions.
      return renderBarChart(dailyChart, {
        series,
        palette: hostPalette(),
        width,
        height: 180,
        formatValue: formatChartValue,
        formatLabel: formatDayLabel,
        accessibleLabel: 'Daily active sessions',
      });
    }

    if (ui.chart === 'bar') {
      // Stacked per-model bars; totals reconcile with daily buckets.
      return renderStackedBarChart(dailyChart, {
        series,
        palette: hostPalette(),
        width,
        height: 180,
        formatValue: formatChartValue,
        formatLabel: formatDayLabel,
        accessibleLabel: `Daily ${METRIC_LABELS[ui.metric]} by model`,
      });
    }

    return renderLineChart(dailyChart, {
      series,
      palette: hostPalette(),
      width,
      height: 180,
      showPoints: series[0]!.points.length <= 32,
      formatValue: formatChartValue,
      formatLabel: formatDayLabel,
      accessibleLabel: `Daily ${METRIC_LABELS[ui.metric]} by model`,
    });
  };

  const dailyWidth = Math.max(
    DEFAULT_CHART_WIDTH,
    chartArea.clientWidth,
    snapshot.daily.length * PER_DAY_PX,
  );
  registry.track(renderDaily(dailyWidth));

  // The wide chart opens at its most recent end.
  requestAnimationFrame(() => scrollToLatest(chartScroll));
  scrollToLatest(chartScroll);

  // Legend mirrors tooltip identity: color, friendly label, reasoning dot.
  const legend = document.createElement('div');
  legend.className = 'an-summary-legend';
  legend.dataset['summaryLegend'] = '';

  for (const entry of series) {
    const item = document.createElement('span');
    item.className = 'an-legend-item';
    const swatch = document.createElement('span');
    swatch.className = 'an-tooltip-swatch';
    swatch.style.backgroundColor = entry.color ?? '';
    item.append(swatch);

    const label = document.createElement('span');
    label.textContent = entry.label;

    const aggregate = snapshot.models.find((model) => model.modelKey === entry.key);

    if (isReasoningModel(aggregate?.modelID ?? entry.key.split('/')[1])) {
      const dot = document.createElement('span');
      dot.className = 'an-reasoning-dot';
      dot.title = 'Reasoning model';
      dot.setAttribute('aria-label', 'Reasoning model');
      label.append(' ', dot);
    }

    item.append(label);
    legend.append(item);
  }

  root.append(legend);
}
