import { formatCompactNumber, formatFullNumber, formatUsd } from '../../shared/formatting';
import type { SectionDeps } from '../page-types';

const MAX_ROWS = 10;

/**
 * Top Projects: up to ten projects ranked by cost then tokens, aligned value
 * columns across rows and a per-project session count. Rendered only while
 * the All Projects scope is active; the controller hides the section root
 * otherwise.
 */
export function renderTopProjects(
  root: HTMLElement,
  deps: SectionDeps,
): void {
  root.textContent = '';
  const { snapshot } = deps;

  const projects = (snapshot.topProjects ?? []).slice(0, MAX_ROWS);

  if (projects.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'an-chart-empty';
    empty.textContent = 'No projects with recorded usage in this period.';
    root.append(empty);
    return;
  }

  const grid = document.createElement('div');
  grid.className = 'an-sessions-grid';
  grid.dataset['projectsGrid'] = '';
  grid.setAttribute('role', 'table');
  grid.setAttribute('aria-label', 'Top projects by cost');
  // Project | sessions | tokens | cost | last activity — aligned across rows.
  grid.style.gridTemplateColumns = 'minmax(0, 1fr) auto auto auto auto';

  const header = document.createElement('div');
  header.className = 'an-sessions-header';
  header.setAttribute('role', 'row');
  for (const label of ['Project', 'Sessions', 'Tokens', 'Cost', 'Last activity']) {
    const cell = document.createElement('span');
    cell.textContent = label;
    cell.setAttribute('role', 'columnheader');
    header.append(cell);
  }
  grid.append(header);

  for (const project of projects) {
    const row = document.createElement('div');
    row.className = 'an-session-row';
    row.dataset['projectRow'] = '';
    row.dataset['projectLabel'] = project.label;
    row.setAttribute('role', 'row');
    row.setAttribute('aria-label', `${project.label}, ${formatUsd(project.cost)}`);

    const label = document.createElement('span');
    label.className = 'an-session-title';
    label.textContent = project.label;
    label.title = project.directory;
    label.setAttribute('role', 'cell');

    const sessions = document.createElement('span');
    sessions.className = 'an-session-project';
    sessions.textContent = `${project.sessions} sessions`;
    sessions.setAttribute('role', 'cell');

    const tokens = document.createElement('span');
    tokens.className = 'an-session-tokens';
    tokens.textContent = `${formatCompactNumber(project.tokens)} tokens`;
    tokens.title = formatFullNumber(project.tokens);
    tokens.setAttribute('role', 'cell');

    const cost = document.createElement('span');
    cost.className = 'an-session-cost';
    cost.textContent = formatUsd(project.cost);
    cost.setAttribute('role', 'cell');

    const activity = document.createElement('span');
    activity.className = 'an-session-activity';
    activity.textContent = new Date(project.lastActivity).toLocaleDateString();
    activity.setAttribute('role', 'cell');

    row.append(label, sessions, tokens, cost, activity);
    grid.append(row);
  }

  root.append(grid);
}
