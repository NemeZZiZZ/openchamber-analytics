// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { buildSnapshot, mountPage, type PageHarness } from '../support/page-harness';

const harnesses: PageHarness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    harness.container.remove();
    document.body.textContent = '';
  }
});

function projectsSection(harness: PageHarness): HTMLElement {
  return harness.container.querySelector('[data-section="top-projects"]') as HTMLElement;
}

describe('top projects', () => {
  it('renders ranked rows with label, tokens, cost, and session count', async () => {
    const harness = await mountPage({ snapshot: buildSnapshot() });
    harnesses.push(harness);

    const rows = [...projectsSection(harness).querySelectorAll('[data-project-row]')];

    expect(rows).toHaveLength(3);
    const first = rows[0] as HTMLElement;
    expect(first.dataset['projectLabel']).toBe('demo');
    expect(first.textContent).toContain('demo');
    expect(first.textContent).toContain('$');
    expect(first.textContent).toContain('tokens');
    expect(first.textContent).toContain('22 sessions');
  });

  it('sits before the Top Sessions section on the page', async () => {
    const harness = await mountPage({ snapshot: buildSnapshot() });
    harnesses.push(harness);

    const order = [...harness.container.querySelectorAll('section[data-section]')].map((section) => (section as HTMLElement).dataset['section']);
    expect(order.indexOf('top-projects')).toBeGreaterThan(-1);
    expect(order.indexOf('top-projects')).toBeLessThan(order.indexOf('top-sessions'));
  });

  it('hides the whole section when a single project scope is active', async () => {
    const harness = await mountPage({
      snapshot: buildSnapshot({ filters: { scope: 'project', range: '30d', surface: 'page', timeZone: 'UTC' } }),
    });
    harnesses.push(harness);

    expect(projectsSection(harness).hidden).toBe(true);
  });

  it('renders an empty state for a legacy service without topProjects', async () => {
    const snapshot = buildSnapshot();
    delete (snapshot as Partial<typeof snapshot>).topProjects;
    const harness = await mountPage({ snapshot });
    harnesses.push(harness);

    expect(projectsSection(harness).textContent).toContain('No projects');
  });

  it('shows an empty note when no projects have usage in the period', async () => {
    const harness = await mountPage({ snapshot: buildSnapshot({ topProjects: [] }) });
    harnesses.push(harness);

    const empty = projectsSection(harness).querySelector('.an-chart-empty') as HTMLElement;
    expect(empty).not.toBeNull();
    expect(empty.textContent).toContain('No projects');
  });
});
