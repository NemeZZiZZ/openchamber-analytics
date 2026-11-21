import type { AnalyticsRange, AnalyticsSnapshot } from '../shared/analytics-types';
import { createSelectControl, type ControlOption } from '../ui/controls';
import { bindSurfaceSize } from '../ui/resize-observer';
import { renderSyncStatus } from '../ui/sync-status';
import type { HostBridge } from '../shared/host';
import { PROJECT_SEARCH_THRESHOLD, projectFilterPatch, projectSelectOptions, projectSelectValue } from '../shared/project-filter';
import { createSurfaceController, type SurfaceController, type SurfaceStatus } from '../shared/surface-controller';
import { saveSurfacePreferences, type SurfacePreferences } from '../shared/preferences';
import { createHandleRegistry, type HandleRegistry, type PageUiState } from './page-types';
import { renderUsageSummary } from './sections/usage-summary';
import { renderActivity } from './sections/activity';
import { renderOverview, renderEfficiency } from './sections/overview';
import { renderModels } from './sections/models';
import { renderTrends } from './sections/trends';
import { renderTopSessions, bindSessionNavigation } from './sections/top-sessions';
import { renderTopProjects } from './sections/top-projects';
import { resolveStateBlock, renderStateBlock, type PageStateKind } from './sections/states';

export type PageControllerOptions = {
  container: HTMLElement;
  bridge: HostBridge;
  preferences?: SurfacePreferences;
  timeZone?: () => string;
  eventDebounceMs?: number;
};

export type PageController = {
  /** Starts the underlying surface controller (idempotent). */
  start(): void;
  dispose(): Promise<void>;
};

const PERIOD_OPTIONS: ControlOption[] = [
  { value: '1d', label: 'Today' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: 'all', label: 'All time' },
];

const NO_DIRECTORY_NOTE = 'No current directory is known, so this view cannot be scoped to one project.';

/**
 * The full Analytics page. Builds the semantic DOM skeleton once, renders all
 * six spec-ordered sections from snapshots served by the shared surface
 * controller, and never talks to OpenCode directly. UI preferences
 * (scope/range/metric/view/chart) persist per installation; failed refreshes
 * keep the last good data visible behind an explanatory banner.
 */
export function createPageController(options: PageControllerOptions): PageController {
  const { container, bridge } = options;
  const registry: HandleRegistry = createHandleRegistry();

  const ui: PageUiState = {
    metric: options.preferences?.metric ?? 'tokens',
    view: options.preferences?.view ?? 'daily',
    chart: options.preferences?.chart ?? 'bar',
    modelsMetric: 'tokens',
  };

  const controller: SurfaceController = createSurfaceController({
    bridge,
    surface: 'page',
    preferences: {
      scope: options.preferences?.scope ?? 'all',
      range: options.preferences?.range ?? '30d',
      directory: options.preferences?.directory,
    },
    timeZone: options.timeZone,
    eventDebounceMs: options.eventDebounceMs,
  });

  let snapshot: AnalyticsSnapshot | null = null;
  let status: SurfaceStatus = 'idle';
  let directory: string | null = null;
  let disposed = false;

  // ---- Skeleton ----
  container.textContent = '';
  container.className = 'an-analytics-page';

  const header = document.createElement('header');
  header.className = 'an-page-header';

  const projectSelect = createSelectControl({
    options: projectSelectOptions({ hasDirectory: false }).map((option) => ({ value: option.value, label: option.label })),
    value: 'all',
    ariaLabel: 'Project',
    searchable: false,
    onChange: (value) => {
      const patch = projectFilterPatch(value);

      if (patch !== null) {
        controller.setFilters(patch);
        void persist();
      }
    },
  });
  projectSelect.element.dataset['projectSelect'] = '';

  const periodSelect = createSelectControl({
    options: PERIOD_OPTIONS,
    value: options.preferences?.range ?? '30d',
    ariaLabel: 'Period',
    onChange: (value) => {
      controller.setFilters({ range: value as AnalyticsRange });
      void persist();
    },
  });
  periodSelect.element.dataset['periodSelect'] = '';

  const syncWrap = document.createElement('div');
  syncWrap.className = 'an-sync-wrap';

  header.append(projectSelect.element, periodSelect.element, syncWrap);
  container.append(header);

  const stateWrap = document.createElement('div');
  stateWrap.className = 'an-state-wrap';
  stateWrap.dataset['stateWrap'] = '';
  container.append(stateWrap);

  const unbindSize = bindSurfaceSize(container);
  let disposeState: () => void = () => {};

  const main = document.createElement('main');
  main.className = 'an-page-main';
  container.append(main);

  const sections = new Map<string, { root: HTMLElement; content: HTMLElement; head: HTMLElement }>();

  for (const key of ['usage-summary', 'activity', 'overview', 'efficiency', 'trends', 'models', 'top-projects', 'top-sessions']) {
    const section = document.createElement('section');
    section.className = 'an-page-section';
    section.dataset['section'] = key;

    const heading = document.createElement('h2');
    heading.className = 'an-section-head';
    heading.textContent =
      key === 'usage-summary' ? 'Usage Summary'
      : key === 'activity' ? 'Activity'
      : key === 'overview' ? 'Overview'
      : key === 'efficiency' ? 'Efficiency'
      : key === 'models' ? 'Models'
      : key === 'trends' ? 'Trends'
      : key === 'top-projects' ? 'Top Projects'
      : 'Top Sessions';

    const content = document.createElement('div');
    content.className = 'an-section-content';

    section.append(heading, content);
    main.append(section);
    sections.set(key, { root: section, content, head: heading });
  }

  const unbindSessions = bindSessionNavigation(sections.get('top-sessions')!.content, (sessionId) =>
    bridge.openSession(sessionId),
  );

  // ---- Rendering ----

  async function persist(): Promise<void> {
    const state = controller.getState();
    await saveSurfacePreferences(bridge.storage, 'page', {
      scope: state.filters.scope,
      range: state.filters.range,
      // Only an explicit pin is stored; a follow identity resolves at load.
      directory: state.pinnedDirectory,
      metric: ui.metric,
      view: ui.view,
      chart: ui.chart,
    });
  }

  function updateProjectControl(): void {
    const state = controller.getState();
    const filters = state.filters;
    const hasDirectory = directory !== null && directory !== '';
    const options = projectSelectOptions({ hasDirectory, projects: snapshot?.projects, pinned: state.pinnedDirectory });
    // The pin decides the displayed identity; a follow selection is "this".
    const value = projectSelectValue(filters.scope, state.pinnedDirectory);
    const active = options.some((option) => option.value === value) ? value : 'all';

    projectSelect.handle.update({
      options: options.map((option) => ({ id: option.value, label: option.label, hint: option.hint, disabled: option.disabled })),
      value: active,
      searchable: (snapshot?.projects?.length ?? 0) > PROJECT_SEARCH_THRESHOLD,
    });
    projectSelect.element.title = hasDirectory ? '' : NO_DIRECTORY_NOTE;
    periodSelect.handle.update({ value: filters.range });
  }

  function renderSections(): void {
    if (!snapshot) {
      return;
    }

    registry.destroyAll();

    renderUsageSummary(sections.get('usage-summary')!.content, {
      snapshot: snapshot as AnalyticsSnapshot,
      ui,
      registry,
      actions: {
        setMetric: (metric) => {
          ui.metric = metric;
          void persist();
          renderSections();
        },
        setView: (view) => {
          ui.view = view;
          void persist();
          renderSections();
        },
        setChart: (chart) => {
          ui.chart = chart;
          void persist();
          renderSections();
        },
      },
    });

    renderActivity(sections.get('activity')!.content, { snapshot, ui, registry });
    renderOverview(sections.get('overview')!.content, { snapshot, ui, registry });
    renderEfficiency(sections.get('efficiency')!.content, { snapshot, ui, registry });
    renderModels(sections.get('models')!.content, {
      head: sections.get('models')!.head,
      snapshot: snapshot as AnalyticsSnapshot,
      ui,
      registry,
      setModelsMetric: (modelsMetric) => {
        ui.modelsMetric = modelsMetric;
        renderSections();
      },
    });
    renderTrends(sections.get('trends')!.content, { snapshot, ui, registry });
    // Top Projects is only meaningful across projects; scoped views hide it.
    sections.get('top-projects')!.root.hidden = snapshot.filters.scope !== 'all';
    renderTopProjects(sections.get('top-projects')!.content, { snapshot, ui, registry });
    renderTopSessions(sections.get('top-sessions')!.content, {
      snapshot,
      ui,
      registry,
      openSession: (sessionId) => bridge.openSession(sessionId),
    });
  }

  function renderState(): void {
    const stateKind: PageStateKind | null = resolveStateBlock(snapshot, status);
    disposeState();
    disposeState = () => {};
    stateWrap.textContent = '';

    if (stateKind === 'sync-failed' || (status === 'error' && snapshot)) {
      // A failed refresh keeps the last good data visible; the banner
      // explains it above the sections.
      disposeState = renderStateBlock(stateWrap, 'sync-failed');
      main.hidden = false;
      return;
    }

    if (stateKind) {
      disposeState = renderStateBlock(stateWrap, stateKind);
      main.hidden = true;
      return;
    }

    main.hidden = false;
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

  // ---- Controller wiring ----

  controller.onHostContext((context) => {
    directory = context.directory ?? null;
    updateProjectControl();
  });

  controller.onSnapshot((next) => {
    if (disposed) {
      return;
    }

    snapshot = next;
    renderState();
    renderSections();
    renderSync();
    updateProjectControl();
  });

  controller.onStatus((next) => {
    if (disposed) {
      return;
    }

    status = next;
    renderState();
    renderSync();
    updateProjectControl();
  });

  updateProjectControl();
  renderSync();
  controller.start();

  return {
    start() {
      controller.start();
    },

    async dispose(): Promise<void> {
      if (disposed) {
        return;
      }

      disposed = true;
      unbindSessions();
      unbindSize();
      disposeState();
      projectSelect.handle.dispose();
      periodSelect.handle.dispose();
      registry.destroyAll();
      await controller.dispose();
      container.textContent = '';
    },
  };
}
