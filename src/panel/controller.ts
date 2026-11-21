import type { AnalyticsSnapshot } from '../shared/analytics-types';
import { formatCompactNumber, formatDayLabel, formatFullNumber, formatUsd, formatUsdExact } from '../shared/formatting';
import { createSelectControl } from '../ui/controls';
import { bindSurfaceSize } from '../ui/resize-observer';
import { renderSyncStatus } from '../ui/sync-status';
import { renderSparkline } from '../ui/charts/sparkline';
import { renderBarChart } from '../ui/charts/bar-chart';
import { formatSessionSpan, formatPercent } from '../shared/formatting';
import { hostPalette } from '../ui/charts/palette';
import type { AnalyticsRange } from '../shared/analytics-types';
import type { HostBridge } from '../shared/host';
import { createSurfaceController, type SurfaceController, type SurfaceStatus } from '../shared/surface-controller';
import type { TpsRate } from '../service/tps';
import type { SurfacePreferences } from '../shared/preferences';
import { defaultPreferences, saveSurfacePreferences } from '../shared/preferences';
import { PROJECT_SEARCH_THRESHOLD, projectFilterPatch, projectSelectOptions, projectSelectValue } from '../shared/project-filter';
import { modelDisplayName } from '../page/page-types';
import { renderStateBlock, resolveStateBlock } from '../page/sections/states';

export type PanelControllerOptions = {
  container: HTMLElement;
  bridge: HostBridge;
  preferences?: SurfacePreferences;
  timeZone?: () => string;
  eventDebounceMs?: number;
};

export type PanelController = {
  start(): void;
  dispose(): Promise<void>;
};

const PERIOD_OPTIONS = [
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
  { value: '90d', label: '90d' },
  { value: 'all', label: 'All' },
];

/**
 * The compact rail panel: the most useful current-period numbers plus small
 * activity/model/session summaries. It consumes the SAME surface controller,
 * snapshot formulas, and theme setup as the full page — never a separate
 * brand. The host exposes no public API for a panel to open its own full
 * page, so the footer only points at Pages → Analytics.
 */
export function createPanelController(options: PanelControllerOptions): PanelController {
  const { container, bridge } = options;

  // The panel opens next to the host project: its own default is This project.
  const base = options.preferences ?? defaultPreferences('panel');

  const controller: SurfaceController = createSurfaceController({
    bridge,
    surface: 'panel',
    preferences: {
      scope: base.scope,
      range: base.range,
      directory: base.directory,
    },
    timeZone: options.timeZone,
    eventDebounceMs: options.eventDebounceMs,
  });

  let snapshot: AnalyticsSnapshot | null = null;
  let status: SurfaceStatus = 'idle';
  let directory: string | null = null;
  let disposed = false;
  const registryHandles: { destroy(): void }[] = [];

  // ---- TPS meter wiring ----
  // The panel follows the open session: the host context carries its id, the
  // panel hands origin + session to the service and polls the rate at 250ms,
  // exactly like the standalone tps-meter plugin it replaces.
  const tpsPeak = { value: 0 };
  let watchedSessionId: string | null = null;
  let ratePollTimer: ReturnType<typeof setInterval> | null = null;
  let rate: TpsRate | null = null;
  const canWatch = typeof location !== 'undefined' && /^https?:$/.test(location.protocol);
  const origin = typeof location !== 'undefined' ? location.origin : '';

  // ---- Skeleton (built once) ----
  container.textContent = '';
  container.className = 'an-analytics-panel';

  const header = document.createElement('header');
  header.className = 'an-panel-header';

  // No in-frame title: the host already labels the panel frame "Analytics";
  // duplicating it wasted the narrowest header row.
  const syncWrap = document.createElement('div');
  syncWrap.className = 'an-panel-sync';
  header.append(syncWrap);

  const controls = document.createElement('div');
  controls.className = 'an-panel-controls';

  const scopeSelect = createSelectControl({
    options: projectSelectOptions({ hasDirectory: false }).map((option) => ({ value: option.value, label: option.label })),
    value: 'all',
    ariaLabel: 'Project',
    searchable: false,
    onChange: (value) => {
      const patch = projectFilterPatch(value);

      if (patch !== null) {
        controller.setFilters(patch);
        void save();
      }
    },
  });
  scopeSelect.element.dataset['panelScope'] = '';

  const rangeSelect = createSelectControl({
    options: PERIOD_OPTIONS,
    value: base.range,
    ariaLabel: 'Period',
    onChange: (value) => {
      controller.setFilters({ range: value as AnalyticsRange });
      void save();
    },
  });
  rangeSelect.element.dataset['panelRange'] = '';

  controls.append(scopeSelect.element, rangeSelect.element);

  const stateWrap = document.createElement('div');
  stateWrap.className = 'an-state-wrap';
  stateWrap.dataset['stateWrap'] = '';

  const body = document.createElement('div');
  body.className = 'an-panel-body';

  // Live generation-rate meter (TPS). Rendered when a session is watched.
  const tps = document.createElement('div');
  tps.className = 'an-panel-tps';
  tps.dataset['tps'] = '';
  body.append(tps);

  const kpis = document.createElement('div');
  kpis.className = 'an-panel-kpis';
  body.append(kpis);

  const activity = document.createElement('div');
  activity.className = 'an-panel-activity';
  body.append(activity);

  const minis = document.createElement('div');
  minis.className = 'an-panel-minis';
  body.append(minis);

  const efficiency = document.createElement('div');
  efficiency.className = 'an-panel-efficiency';
  body.append(efficiency);

  const models = document.createElement('div');
  models.className = 'an-panel-models';
  body.append(models);

  const sessions = document.createElement('div');
  sessions.className = 'an-panel-sessions';
  body.append(sessions);

  const coverage = document.createElement('div');
  coverage.className = 'an-panel-coverage';
  body.append(coverage);

  const footer = document.createElement('footer');
  footer.className = 'an-panel-footer';
  footer.dataset['panelFooter'] = '';
  footer.textContent = 'Full report: Pages → Analytics';

  container.append(header, controls, stateWrap, body, footer);

  const unbindSize = bindSurfaceSize(container);
  let disposeState: () => void = () => {};

  function updateScope(): void {
    const state = controller.getState();
    const filters = state.filters;
    const hasDirectory = directory !== null && directory !== '';
    const options = projectSelectOptions({ hasDirectory, projects: snapshot?.projects, pinned: state.pinnedDirectory });
    // The pin decides the displayed identity; a follow selection is "this".
    const value = projectSelectValue(filters.scope, state.pinnedDirectory);
    const active = options.some((option) => option.value === value) ? value : 'all';

    scopeSelect.handle.update({
      options: options.map((option) => ({ id: option.value, label: option.label, hint: option.hint, disabled: option.disabled })),
      value: active,
      searchable: (snapshot?.projects?.length ?? 0) > PROJECT_SEARCH_THRESHOLD,
    });
    rangeSelect.handle.update({ value: filters.range });
  }

  async function save(): Promise<void> {
    // The panel owns its surface key; metric/view/chart ride along from the
    // loaded base but the page keeps its own key.
    const state = controller.getState();
    await saveSurfacePreferences(bridge.storage, 'panel', {
      ...base,
      scope: state.filters.scope,
      range: state.filters.range,
      // Only an explicit pin is stored; a follow identity resolves at load.
      directory: state.pinnedDirectory,
    });
  }

  function kpi(key: string, label: string, value: string, full: string): void {
    const existing = kpis.querySelector(`[data-kpi="${key}"]`) as HTMLElement | null;

    if (existing) {
      existing.textContent = value;
      existing.title = full;
      existing.setAttribute('aria-label', `${label}: ${full}`);
      return;
    }

    const wrap = document.createElement('div');
    wrap.className = 'an-panel-kpi';

    const labelEl = document.createElement('span');
    labelEl.className = 'an-stat-label';
    labelEl.textContent = label;

    const valueEl = document.createElement('span');
    valueEl.className = 'an-stat-value';
    valueEl.dataset['kpi'] = key;
    valueEl.textContent = value;
    valueEl.title = full;
    valueEl.setAttribute('aria-label', `${label}: ${full}`);

    wrap.append(labelEl, valueEl);
    kpis.append(wrap);
  }

  function renderPanel(): void {
    if (!snapshot) {
      return;
    }

    const current = snapshot;

    for (const handle of registryHandles.splice(0)) {
      handle.destroy();
    }

    // Six KPIs: the core four plus cache hit rate and the average wall-clock
    // session span, mirroring the page's Overview and Efficiency cards.
    kpi('tokens', 'Tokens', formatCompactNumber(snapshot.summary.tokens), formatFullNumber(snapshot.summary.tokens));
    kpi('cost', 'Cost', formatUsd(snapshot.summary.cost), formatUsd(snapshot.summary.cost));
    kpi('sessions', 'Sessions', formatCompactNumber(snapshot.summary.sessions), formatFullNumber(snapshot.summary.sessions));
    kpi('active-days', 'Active days', formatCompactNumber(snapshot.summary.activeDays), formatFullNumber(snapshot.summary.activeDays));
    kpi('cache-hit', 'Cache hit', formatPercent(snapshot.summary.cacheHitRate), `${formatFullNumber(snapshot.summary.cacheHitRate * 100)}% of input + cache reads`);
    kpi('avg-span', 'Avg span', formatSessionSpan(snapshot.efficiency.avgSessionSpan), `wall-clock ${formatSessionSpan(snapshot.efficiency.avgSessionSpan)}`);

    // Compact daily activity: tokens sparkline plus sessions/cost mini bars.
    activity.textContent = '';
    if (snapshot.daily.length > 1) {
      const sparkWrap = document.createElement('div');
      registryHandles.push(
        renderSparkline(sparkWrap, {
          values: snapshot.daily.map((bucket) => bucket.tokens),
          labels: snapshot.daily.map((bucket) => bucket.day),
          formatValue: formatCompactNumber,
          formatLabel: formatDayLabel,
          tooltipLabel: 'Tokens',
          palette: hostPalette(),
          width: 220,
          height: 28,
          accessibleLabel: 'Daily tokens, latest buckets',
        }),
      );
      const caption = document.createElement('span');
      caption.className = 'an-panel-mini-caption';
      caption.textContent = 'Tokens / day';
      activity.append(sparkWrap, caption);
    }

    // Mini charts: cost per day and sessions per day.
    minis.textContent = '';
    if (snapshot.daily.length > 1) {
      const palette = hostPalette();

      const mini = (
        key: string,
        label: string,
        pick: (bucket: AnalyticsSnapshot['daily'][number]) => number,
        color: string,
        formatValue: (value: number) => string,
      ): void => {
        const wrap = document.createElement('div');
        wrap.className = 'an-panel-mini';
        wrap.dataset['mini'] = key;
        registryHandles.push(
          renderBarChart(wrap, {
            series: [{ key, label, points: current.daily.map((bucket) => ({ label: bucket.day, value: pick(bucket) })) }],
            palette: [color],
            width: 220,
            height: 44,
            showLabels: false,
            formatValue,
            accessibleLabel: `Daily ${label.toLowerCase()}`,
          }),
        );
        const caption = document.createElement('span');
        caption.className = 'an-panel-mini-caption';
        caption.textContent = label;
        wrap.append(caption);
        minis.append(wrap);
      };

      mini('cost', 'Cost / day', (bucket) => bucket.cost, palette[0] ?? '#4c8dff', formatUsd);
      mini('sessions', 'Sessions / day', (bucket) => bucket.sessions, palette[1] ?? '#39c0ed', formatCompactNumber);
    }

    // Efficiency strip: three compact values from the Efficiency card set.
    efficiency.textContent = '';
    const efficiencyItems: { label: string; value: string; full: string }[] = [
      { label: 'Cost / M', value: formatUsdExact(snapshot.efficiency.costPerMillion), full: formatUsdExact(snapshot.efficiency.costPerMillion) },
      { label: 'Tok / session', value: formatCompactNumber(snapshot.efficiency.tokensPerSession), full: formatFullNumber(snapshot.efficiency.tokensPerSession) },
      { label: 'Reasoning', value: formatPercent(snapshot.efficiency.reasoningShare), full: `${formatFullNumber(snapshot.efficiency.reasoningShare * 100)}% of tokens` },
    ];

    for (const item of efficiencyItems) {
      const cell = document.createElement('div');
      cell.className = 'an-panel-efficiency-cell';

      const labelEl = document.createElement('span');
      labelEl.className = 'an-stat-label';
      labelEl.textContent = item.label;

      const valueEl = document.createElement('span');
      valueEl.className = 'an-stat-value';
      valueEl.textContent = item.value;
      valueEl.title = item.full;
      valueEl.setAttribute('aria-label', `${item.label}: ${item.full}`);

      cell.append(labelEl, valueEl);
      efficiency.append(cell);
    }

    // Top models: up to three rows by tokens, with a proportional share track.
    models.textContent = '';
    const modelHeading = document.createElement('span');
    modelHeading.className = 'an-panel-heading';
    modelHeading.textContent = 'Top models';
    models.append(modelHeading);

    const maxModelTokens = Math.max(1, ...snapshot.models.slice(0, 3).map((model) => model.tokens));

    for (const model of snapshot.models.slice(0, 3)) {
      const row = document.createElement('div');
      row.className = 'an-panel-row an-panel-model-row';
      row.dataset['panelModel'] = '';
      row.title = `${formatFullNumber(model.tokens)} tokens · ${formatUsd(model.cost)}`;

      const name = document.createElement('span');
      name.textContent = modelDisplayName(model.providerID, model.modelID, model.modelKey);

      const track = document.createElement('span');
      track.className = 'an-panel-track';
      const fill = document.createElement('span');
      fill.className = 'an-panel-track-fill';
      fill.style.width = `${Math.round((model.tokens / maxModelTokens) * 100)}%`;
      track.append(fill);

      row.append(name, track);
      models.append(row);
    }

    // Top sessions: up to three rows, title + cost.
    sessions.textContent = '';
    const sessionHeading = document.createElement('span');
    sessionHeading.className = 'an-panel-heading';
    sessionHeading.textContent = 'Top sessions';
    sessions.append(sessionHeading);

    for (const session of snapshot.topSessions.slice(0, 3)) {
      const row = document.createElement('div');
      row.className = 'an-panel-row';
      row.dataset['panelSession'] = '';
      row.textContent = session.title;
      row.title = `${session.title} — ${formatUsd(session.cost)}`;
      sessions.append(row);
    }

    // Coverage / last updated.
    coverage.textContent = `${snapshot.coverage.complete}/${snapshot.coverage.total} sessions complete · updated ${new Date(snapshot.generatedAt).toLocaleTimeString()}`;
    coverage.title = `${snapshot.coverage.pending} pending, ${snapshot.coverage.failed} failed, ${snapshot.coverage.mismatch} mismatched, ${snapshot.coverage.residual} residual`;
  }

  function renderState(): void {
    const kind = resolveStateBlock(snapshot, status);
    disposeState();
    disposeState = () => {};
    stateWrap.textContent = '';

    if (kind && kind !== 'sync-failed') {
      disposeState = renderStateBlock(stateWrap, kind);
      body.hidden = true;
      return;
    }

    if (status === 'error' && snapshot) {
      disposeState = renderStateBlock(stateWrap, 'sync-failed');
    }

    body.hidden = false;
  }

  function renderSync(): void {
    renderSyncStatus(syncWrap, {
      status,
      precision: snapshot?.precision,
      coverage: snapshot?.coverage,
      refreshing: status === 'loading' || status === 'refreshing',
      onRefresh: () => controller.refresh(),
    });
  }

  // ---- TPS rendering and polling ----

  const fmtTokPerSecond = (value: number): string => (value >= 100 ? String(Math.round(value)) : value.toFixed(1));

  function renderTps(): void {
    if (!rate || rate.sessionId === null) {
      // No open session: the meter block folds away so the rail stays compact.
      tps.hidden = true;
      tps.textContent = '';
      return;
    }

    tps.hidden = false;
    tps.textContent = '';

    const headline = document.createElement('div');
    headline.className = 'an-tps-headline';

    const value = document.createElement('span');
    value.className = 'an-tps-value';
    value.dataset['tpsValue'] = '';
    value.textContent = fmtTokPerSecond(rate.tokensPerSecond);
    value.setAttribute(
      'aria-label',
      `${fmtTokPerSecond(rate.tokensPerSecond)} tokens per second over the last ${Math.round(rate.windowMs / 1000)} seconds`,
    );

    const unit = document.createElement('span');
    unit.className = 'an-tps-unit';
    unit.textContent = 'tok/s';

    const state = document.createElement('span');
    state.className = 'an-tps-state';
    state.dataset['tpsState'] = '';
    state.textContent =
      rate.waiting === 'permission' ? 'waiting for permission'
      : rate.waiting === 'question' ? 'waiting for answer'
      : rate.busy || rate.active ? 'generating'
      : 'idle';

    headline.append(value, unit, state);
    tps.append(headline);

    // Peak bar: the live rate against the recent maximum of this session.
    if (rate.active && rate.tokensPerSecond > tpsPeak.value) {
      tpsPeak.value = rate.tokensPerSecond;
    }

    const track = document.createElement('div');
    track.className = 'an-tps-track';
    const fill = document.createElement('div');
    fill.className = 'an-tps-track-fill';
    fill.dataset['tpsBar'] = '';
    const peak = Math.max(tpsPeak.value, 0.001);
    fill.style.width = `${Math.min(100, Math.round((rate.tokensPerSecond / peak) * 100))}%`;
    track.append(fill);
    tps.append(track);

    const rows: { label: string; value: string; key?: string }[] = [
      {
        label: 'Last turn',
        value: rate.lastTurn
          ? `${fmtTokPerSecond(rate.lastTurn.tokensPerSecond)} tok/s · ${formatCompactNumber(rate.lastTurn.tokens)} tok${rate.lastTurn.source === 'estimate' ? ' (~)' : ''}`
          : 'No finished turn yet.',
      },
      {
        label: 'Session generated',
        value: rate.sessionUsage ? formatCompactNumber(rate.sessionUsage.generated) : '—',
        key: 'tps-session-tokens',
      },
      { label: 'Chars/s', value: rate.charsPerSecond >= 1 ? String(Math.round(rate.charsPerSecond)) : '0' },
      { label: 'Tokens/char', value: rate.charsPerToken.toFixed(2) },
    ];

    for (const row of rows) {
      const line = document.createElement('div');
      line.className = 'an-tps-row';

      const label = document.createElement('span');
      label.textContent = row.label;

      const valueEl = document.createElement('span');
      valueEl.textContent = row.value;

      if (row.key) {
        // setAttribute: dataset rejects dash keys as invalid property names.
        valueEl.setAttribute(`data-${row.key}`, '');
      }

      line.append(label, valueEl);
      tps.append(line);
    }
  }

  async function pollRate(): Promise<void> {
    if (disposed) {
      return;
    }

    try {
      const result = await bridge.serviceRequest({ method: 'GET', path: '/v1/rate' });

      if (disposed || result.status !== 200) {
        return;
      }

      rate = JSON.parse(result.body) as typeof rate;
      renderTps();
    } catch (error) {
      // A failed poll keeps the previous rendering; the next tick retries.
      console.error('[analytics] rate poll failed:', error instanceof Error ? error.message : error);
    }
  }

  async function updateWatch(sessionId: string | null): Promise<void> {
    if (disposed || sessionId === watchedSessionId) {
      return;
    }

    watchedSessionId = sessionId;

    if (!canWatch) {
      return;
    }

    try {
      await bridge.serviceRequest({
        method: 'POST',
        path: '/v1/watch',
        body: JSON.stringify({ origin, sessionId }),
      });
    } catch {
      // The service may not have the meter yet; polling continues regardless.
    }
  }

  controller.onHostContext((context) => {
    directory = context.directory ?? null;
    updateScope();
    // Follow the open session for TPS metering; a null session unwatches.
    void updateWatch(context.session?.id ?? null);
  });

  controller.onSnapshot((next) => {
    if (disposed) {
      return;
    }

    snapshot = next;
    renderState();
    renderPanel();
    renderSync();
    updateScope();
  });

  controller.onStatus((next) => {
    if (disposed) {
      return;
    }

    status = next;
    renderState();
    renderSync();
  });

  return {
    start() {
      controller.start();

      // Poll the service rate at the panel cadence the tps-meter plugin used.
      if (ratePollTimer === null && !disposed) {
        void pollRate();
        ratePollTimer = setInterval(() => {
          // A hidden panel has nobody watching the meter: skip the proxy round trip.
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
            return;
          }

          void pollRate();
        }, 250);
      }
    },

    async dispose(): Promise<void> {
      if (disposed) {
        return;
      }

      disposed = true;

      if (ratePollTimer !== null) {
        clearInterval(ratePollTimer);
        ratePollTimer = null;
      }

      void updateWatch(null);
      unbindSize();
      disposeState();
      scopeSelect.handle.dispose();
      rangeSelect.handle.dispose();

      for (const handle of registryHandles.splice(0)) {
        handle.destroy();
      }

      await controller.dispose();
      container.textContent = '';
    },
  };
}

