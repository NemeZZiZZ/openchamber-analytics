import type { AnalyticsMetric, AnalyticsSnapshot, ModelAggregate } from '../../shared/analytics-types';
import { formatCompactNumber, formatFullNumber, formatUsd } from '../../shared/formatting';
import { createTabsControl } from '../../ui/controls';
import { modelDisplayName, type HandleRegistry, type PageUiState } from '../page-types';

/**
 * Rows whose share of the selected metric total falls below this fraction are
 * hidden behind a toggle — a long zero-value tail makes the leaderboard
 * unreadable (mirrors the host Stats page).
 */
const LOW_SHARE_THRESHOLD = 0.005;

function metricOf(model: ModelAggregate, metric: Exclude<AnalyticsMetric, 'sessions'>): number {
  if (metric === 'cost') {
    return model.cost;
  }

  if (metric === 'steps') {
    return model.steps;
  }

  return model.tokens;
}

function metricLabel(metric: Exclude<AnalyticsMetric, 'sessions'>): string {
  return metric === 'cost' ? 'Cost' : metric === 'steps' ? 'Steps' : 'Tokens';
}

function valueText(model: ModelAggregate, metric: Exclude<AnalyticsMetric, 'sessions'>): string {
  if (metric === 'cost') {
    return formatUsd(model.cost);
  }

  const primary = metric === 'steps' ? formatCompactNumber(model.steps) : formatCompactNumber(model.tokens);
  return `${primary} · ${formatUsd(model.cost)}`;
}

function valueFull(model: ModelAggregate): string {
  return `Tokens ${formatFullNumber(model.tokens)} · cost ${formatUsd(model.cost)} · steps ${formatFullNumber(model.steps)}`;
}

/**
 * Models: the per-model leaderboard for the period (variants rank as separate
 * rows), with a Tokens/Cost/Steps toggle that shares the section heading row,
 * share tracks, and token · cost values — matching the host Stats page. Rows
 * below a small share of the metric total are collapsed behind a toggle.
 */
export function renderModels(
  root: HTMLElement,
  deps: {
    head: HTMLElement;
    snapshot: AnalyticsSnapshot;
    ui: PageUiState;
    registry: HandleRegistry;
    setModelsMetric: (metric: AnalyticsMetric) => void;
  },
): void {
  root.textContent = '';
  const { snapshot, registry, ui } = deps;
  const metric = ui.modelsMetric === 'sessions' ? 'tokens' : ui.modelsMetric;

  // The metric toggle shares the section heading row: one heading, one row.
  const head = deps.head;
  head.classList.add('an-section-head-row');
  head.textContent = 'Models';

  const tabs = createTabsControl({
    options: (['tokens', 'cost', 'steps'] as const).map((option) => ({ value: option, label: metricLabel(option) })),
    value: metric,
    ariaLabel: 'Models metric',
    onChange: (value) => deps.setModelsMetric(value as AnalyticsMetric),
  });
  tabs.element.dataset['modelsMetricTabs'] = '';
  registry.track({ destroy: () => tabs.handle.dispose() });
  head.append(tabs.element);

  const ranked = [...snapshot.models].sort(
    (a, b) => metricOf(b, metric) - metricOf(a, metric) || a.modelKey.localeCompare(b.modelKey),
  );
  const total = ranked.reduce((acc, model) => acc + metricOf(model, metric), 0);
  const max = Math.max(1, ...ranked.map((model) => metricOf(model, metric)));

  const mainRows = ranked.filter(
    (model) => total === 0 || metricOf(model, metric) / total >= LOW_SHARE_THRESHOLD,
  );
  const lowRows = ranked.filter(
    (model) => total > 0 && metricOf(model, metric) / total < LOW_SHARE_THRESHOLD,
  );

  const list = document.createElement('div');
  list.className = 'an-models-list';
  list.dataset['modelsList'] = '';

  const buildRow = (model: ModelAggregate): HTMLElement => {
    const row = document.createElement('div');
    row.className = 'an-model-row';
    row.dataset['modelRow'] = model.modelKey;

    const head = document.createElement('div');
    head.className = 'an-model-head';

    const name = document.createElement('span');
    name.className = 'an-model-name';
    name.textContent = modelDisplayName(model.providerID, model.modelID, model.modelKey);
    head.append(name);

    if (model.variant) {
      const variant = document.createElement('span');
      variant.className = 'an-model-variant';
      variant.textContent = model.variant;
      head.append(variant);
    }

    const value = document.createElement('span');
    value.className = 'an-model-value';
    value.textContent = valueText(model, metric);
    value.title = valueFull(model);
    value.setAttribute('aria-label', `${name.textContent}: ${valueFull(model)}`);

    const track = document.createElement('div');
    track.className = 'an-agent-track';
    const fill = document.createElement('div');
    fill.className = 'an-agent-fill';
    fill.style.width = `${Math.round((metricOf(model, metric) / max) * 100)}%`;
    track.append(fill);

    row.append(head, value, track);
    return row;
  };

  const renderRows = (showLow: boolean): void => {
    list.textContent = '';
    const rows = showLow ? ranked : mainRows;

    if (rows.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'an-chart-empty';
      empty.textContent = 'No model activity in this period.';
      list.append(empty);
      return;
    }

    for (const model of rows) {
      list.append(buildRow(model));
    }
  };

  renderRows(false);
  root.append(list);

  if (lowRows.length > 0) {
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'an-models-toggle';
    toggle.dataset['modelsToggle'] = '';
    toggle.textContent = `Show ${lowRows.length} low-share ${lowRows.length === 1 ? 'model' : 'models'}`;

    let showLow = false;
    toggle.addEventListener('click', () => {
      showLow = !showLow;
      renderRows(showLow);
      toggle.textContent = showLow
        ? 'Hide low-share models'
        : `Show ${lowRows.length} low-share ${lowRows.length === 1 ? 'model' : 'models'}`;
    });

    root.append(toggle);
  }
}
