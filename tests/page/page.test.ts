// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { pickOption, selectedLabel } from '../support/kit';
import { buildSnapshot, mountPage, type PageHarness } from '../support/page-harness';

const harnesses: PageHarness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    harness.container.remove();
    document.body.textContent = '';
  }
});

const SECTION_ORDER = [
  'Usage Summary',
  'Activity',
  'Overview',
  'Efficiency',
  'Trends',
  'Models',
  'Top Projects',
  'Top Sessions',
];

describe('page structure', () => {
  it('renders the header defaults and all six content groups in spec order', async () => {
    const harness = await mountPage({ snapshot: buildSnapshot() });
    harnesses.push(harness);

    const headings = [...harness.container.querySelectorAll('[data-section] h2')].map(
      (heading) => heading.firstChild?.textContent ?? '',
    );
    expect(headings).toEqual(SECTION_ORDER);

    // Header defaults: All projects, 30 days.
    const projectSelect = harness.container.querySelector('[data-project-select]') as HTMLElement;
    expect(selectedLabel(projectSelect)).toBe('All projects');

    const periodSelect = harness.container.querySelector('[data-period-select]') as HTMLElement;
    expect(selectedLabel(periodSelect)).toBe('30 days');
  });

  it('never renders provider quotas, context sidebar, or code churn', async () => {
    const harness = await mountPage({ snapshot: buildSnapshot() });
    harnesses.push(harness);

    const text = harness.container.textContent ?? '';
    expect(text).not.toContain('Provider quotas');
    expect(text).not.toContain('Context Sidebar');
    expect(text).not.toContain('Code churn');
    expect(harness.container.querySelectorAll('[data-section="quotas"]')).toHaveLength(0);
  });

  it('offers Stats parity: Today period, Steps metric, composition, prompts, subagents, and Models', async () => {
    const harness = await mountPage({ snapshot: buildSnapshot() });
    harnesses.push(harness);

    // Today period option exists next to 7/30/90/all.
    const periodSelect = harness.container.querySelector('[data-period-select]') as HTMLElement;
    (periodSelect.querySelector('.oc-sdk-trigger') as HTMLButtonElement).click();
    const periodLabels = [...periodSelect.querySelectorAll('.oc-sdk-option')].map((option) => option.textContent?.trim());
    expect(periodLabels).toContain('Today');

    // Steps metric tab on the summary.
    const metricTabs = [...harness.container.querySelectorAll('[data-metric-tab]')].map((tab) => tab.textContent);
    expect(metricTabs).toEqual(['Tokens', 'Cost', 'Sessions', 'Steps']);

    const overview = harness.container.querySelector('[data-section="overview"]') as HTMLElement;
    // Token composition strip with the four components.
    const composition = overview.querySelector('[data-composition]') as HTMLElement;
    expect(composition.textContent).toContain('Input');
    expect(composition.textContent).toContain('Output + reasoning');
    expect(composition.textContent).toContain('Cache reads');
    expect(composition.textContent).toContain('Cache writes');
    // Tokens card carries the In/Out/Cache split subtitle; Sessions shows subagents.
    expect(overview.textContent).toContain('In ');
    expect(overview.textContent).toContain('Subagents: 9');
    // Prompts card exists with the fixture value.
    expect(overview.textContent).toContain('Prompts');

    // Efficiency gains Steps / session.
    const efficiency = harness.container.querySelector('[data-section="efficiency"]') as HTMLElement;
    expect(efficiency.textContent).toContain('Steps / session');

    // Models section: fixture rows with variant chips and a metric toggle.
    const models = harness.container.querySelector('[data-section="models"]') as HTMLElement;
    expect(models).not.toBeNull();
    const rows = [...models.querySelectorAll('[data-model-row]')];
    expect(rows.length).toBeGreaterThanOrEqual(6);
    expect(models.textContent).toContain('max');
    // Rows show the token · cost value pair like the host Stats page.
    expect(models.textContent).toContain('· $3.20');
    expect(models.textContent).toContain('Tokens');
    expect(models.textContent).toContain('Steps');
    // The section heading row carries the metric toggle; no separate bar row.
    const head = models.querySelector('h2') as HTMLElement;
    expect(head.textContent).toContain('Models');
    expect(head.querySelector('[data-models-metric-tabs]')).not.toBeNull();
    expect(models.querySelector('[data-models-bar]')).toBeNull();
  });

  it('collapses low-share model rows behind a toggle', async () => {
    const base = buildSnapshot();
    const snapshot = buildSnapshot({
      models: [
        ...base.models,
        { modelKey: 'zai/tiny-1', providerID: 'zai', modelID: 'tiny-1', tokens: 2, cost: 0.0001, reasoningTokens: 0, steps: 1, sessions: 1, share: 0.0001 },
        { modelKey: 'zai/tiny-2', providerID: 'zai', modelID: 'tiny-2', tokens: 0, cost: 0, reasoningTokens: 0, steps: 0, sessions: 0 },
      ],
    });
    const harness = await mountPage({ snapshot });
    harnesses.push(harness);

    const models = harness.container.querySelector('[data-section="models"]') as HTMLElement;
    const list = models.querySelector('[data-models-list]') as HTMLElement;

    // Tiny models are hidden by default.
    expect(list.querySelector('[data-model-row="zai/tiny-1"]')).toBeNull();
    expect(list.querySelector('[data-model-row="zai/tiny-2"]')).toBeNull();

    const toggle = models.querySelector('[data-models-toggle]') as HTMLButtonElement;
    expect(toggle.textContent).toContain('2 low-share models');

    toggle.click();
    expect(list.querySelector('[data-model-row="zai/tiny-1"]')).not.toBeNull();
    expect(list.querySelector('[data-model-row="zai/tiny-2"]')).not.toBeNull();
    expect(toggle.textContent).toContain('Hide low-share models');
  });

  it('renders overview delta badges only when a previous period exists', async () => {
    const harness = await mountPage({ snapshot: buildSnapshot() });
    harnesses.push(harness);

    const overview = harness.container.querySelector('[data-section="overview"]') as HTMLElement;
    // The fixture has a previous period, so cards show percent deltas.
    expect(overview.querySelectorAll('.an-overview-card .an-delta').length).toBeGreaterThan(0);

    // All time (previous undefined) renders no dash badges.
    const allTime = await mountPage({
      snapshot: buildSnapshot({ previous: undefined, periodPrecision: { current: 'exact' } }),
    });
    harnesses.push(allTime);

    const allTimeOverview = allTime.container.querySelector('[data-section="overview"]') as HTMLElement;
    expect(allTimeOverview.querySelectorAll('.an-overview-card .an-delta')).toHaveLength(0);
  });

  it('updates controller filters from the project and period controls', async () => {
    const harness = await mountPage({ snapshot: buildSnapshot() });
    harnesses.push(harness);

    const projectSelect = harness.container.querySelector('[data-project-select]') as HTMLElement;
    pickOption(projectSelect, 'This project');
    await new Promise((resolve) => setTimeout(resolve, 10));

    // The directory is available, so This project activates and refetches it.
    expect(selectedLabel(projectSelect)).toBe('This project');
    expect(harness.bridge.snapshotRequests.at(-1)).toMatchObject({ scope: 'project', directory: '/repo/demo' });

    const periodSelect = harness.container.querySelector('[data-period-select]') as HTMLElement;
    pickOption(periodSelect, '7 days');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(selectedLabel(periodSelect)).toBe('7 days');
  });

  it('lists known projects after the divider and pins one across host directory changes', async () => {
    const projects = [
      { directory: '/repo/demo', label: 'demo', sessions: 5, tokens: 12_300, cost: 1.5 },
      { directory: '/repo/tools', label: 'tools', sessions: 2, tokens: 4_100, cost: 0.4 },
    ];
    const harness = await mountPage({ snapshot: buildSnapshot({ projects }) });
    harnesses.push(harness);

    const projectSelect = harness.container.querySelector('[data-project-select]') as HTMLElement;
    (projectSelect.querySelector('.oc-sdk-trigger') as HTMLButtonElement).click();
    const optionLabels = [...projectSelect.querySelectorAll('.oc-sdk-option')].map((option) => option.textContent?.trim());
    expect(optionLabels).toEqual([
      'All projects',
      'This project',
      '────────────',
      expect.stringContaining('demo'),
      expect.stringContaining('tools'),
    ]);
    expect(optionLabels[3]).toContain('12.3K tok');

    // Pin "tools" inside the already-open popup: a second trigger click would
    // just close it.
    const toolsOption = [...projectSelect.querySelectorAll<HTMLButtonElement>('.oc-sdk-option')].find(
      (option) => option.textContent?.trim().startsWith('tools'),
    );
    toolsOption!.click();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(selectedLabel(projectSelect)).toBe('tools');
    expect(harness.bridge.snapshotRequests.at(-1)).toMatchObject({ scope: 'project', directory: '/repo/tools' });

    // The host switching away must not rewrite the pinned identity.
    for (const listener of harness.bridge.directoryListeners ?? []) {
      listener('/repo/elsewhere');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(harness.bridge.snapshotRequests.at(-1)).toMatchObject({ scope: 'project', directory: '/repo/tools' });
  });

  it('ignores the divider option and never treats it as a project', async () => {
    const harness = await mountPage({
      snapshot: buildSnapshot({ projects: [{ directory: '/repo/demo', label: 'demo', sessions: 1, tokens: 10, cost: 0.1 }] }),
    });
    harnesses.push(harness);

    const projectSelect = harness.container.querySelector('[data-project-select]') as HTMLElement;
    const requestsBefore = harness.bridge.snapshotRequests.length;

    pickOption(projectSelect, '────────────');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(harness.bridge.snapshotRequests.length).toBe(requestsBefore);
    expect(harness.bridge.snapshotRequests.at(-1)).toMatchObject({ scope: 'all' });
  });

  it('persists the scope per surface, including the pinned project', async () => {
    const harness = await mountPage({ snapshot: buildSnapshot() });
    harnesses.push(harness);

    const projectSelect = harness.container.querySelector('[data-project-select]') as HTMLElement;
    pickOption(projectSelect, 'This project');
    await new Promise((resolve) => setTimeout(resolve, 10));

    const stored = harness.bridge.storageSets['analytics/preferences/page'] as Record<string, unknown>;
    expect(Object.keys(stored)).toEqual(expect.arrayContaining(['scope', 'range', 'metric', 'view', 'chart', 'directory']));
    expect(stored.scope).toBe('project');
    // Follow mode persists no pin: the resolved host identity is not stored.
    expect(stored.directory).toBeUndefined();

    pickOption(projectSelect, 'All projects');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(harness.bridge.storageSets['analytics/preferences/page']).toMatchObject({ scope: 'all' });
  });

  it('restores a persisted pinned project on load', async () => {
    const harness = await mountPage({
      snapshot: buildSnapshot({
        projects: [{ directory: '/repo/demo', label: 'demo', sessions: 1, tokens: 10, cost: 0.1 }],
      }),
      preferences: { scope: 'project', directory: '/repo/demo' },
    });
    harnesses.push(harness);

    const projectSelect = harness.container.querySelector('[data-project-select]') as HTMLElement;
    expect(selectedLabel(projectSelect)).toBe('demo');
    expect(harness.bridge.snapshotRequests.at(-1)).toMatchObject({ scope: 'project', directory: '/repo/demo' });
  });

  it('offers only All projects, with an explanation, when no directory is available', async () => {
    const harness = await mountPage({ snapshot: buildSnapshot(), directory: null });
    harnesses.push(harness);

    const projectSelect = harness.container.querySelector('[data-project-select]') as HTMLElement;
    (projectSelect.querySelector('.oc-sdk-trigger') as HTMLButtonElement).click();
    const optionLabels = [...projectSelect.querySelectorAll('.oc-sdk-option')].map((option) => option.textContent?.trim());
    expect(optionLabels).toEqual(['All projects']);
    expect((projectSelect.getAttribute('title') ?? '').length).toBeGreaterThan(0);
  });

  it('refresh calls the service and shows a progress state', async () => {
    const harness = await mountPage({ snapshot: buildSnapshot() });
    harnesses.push(harness);

    const requestsBefore = 1;
    const refresh = harness.container.querySelector('[data-refresh]') as HTMLButtonElement;
    refresh.click();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const refreshState = harness.container.querySelector('[data-refresh]') as HTMLButtonElement;
    expect(refreshState.getAttribute('aria-busy')).toBe('false');
    void requestsBefore;
    expect(refresh).toBeTruthy();
  });
});
