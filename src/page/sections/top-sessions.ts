import { formatCompactNumber, formatFullNumber, formatUsd } from '../../shared/formatting';
import type { SectionDeps } from '../page-types';

const MAX_ROWS = 10;

/**
 * Top Sessions: up to ten sessions ranked by cost then tokens, aligned value
 * columns across rows and actions, project basename under the muted title,
 * and host navigation on activation. A failed navigation keeps every row and
 * explains itself without fabricating a route.
 */
export function renderTopSessions(
  root: HTMLElement,
  deps: SectionDeps & {
    openSession: (sessionId: string) => void;
  },
): void {
  root.textContent = '';
  const { snapshot } = deps;

  const sessions = snapshot.topSessions.slice(0, MAX_ROWS);

  if (sessions.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'an-chart-empty';
    empty.textContent = 'No sessions with recorded usage in this period.';
    root.append(empty);
    return;
  }

  const grid = document.createElement('div');
  grid.className = 'an-sessions-grid';
  grid.dataset['sessionsGrid'] = '';
  grid.setAttribute('role', 'table');
  grid.setAttribute('aria-label', 'Top sessions by cost');
  // Title | project | tokens | cost | last activity — aligned across rows.
  grid.style.gridTemplateColumns = 'minmax(0, 1fr) auto auto auto auto';

  const header = document.createElement('div');
  header.className = 'an-sessions-header';
  header.setAttribute('role', 'row');
  for (const label of ['Session', 'Project', 'Tokens', 'Cost', 'Last activity']) {
    const cell = document.createElement('span');
    cell.textContent = label;
    cell.setAttribute('role', 'columnheader');
    header.append(cell);
  }
  grid.append(header);

  const errorLine = document.createElement('div');
  errorLine.className = 'an-session-error';
  errorLine.dataset['sessionError'] = '';
  errorLine.setAttribute('role', 'status');

  for (const session of sessions) {
    const row = document.createElement('div');
    row.className = 'an-session-row';
    row.dataset['sessionRow'] = '';
    row.dataset['sessionId'] = session.sessionId;
    row.setAttribute('role', 'row');
    row.tabIndex = 0;
    row.setAttribute('aria-label', `${session.title}, ${formatUsd(session.cost)}`);

    const title = document.createElement('span');
    title.className = 'an-session-title';
    title.textContent = session.title;
    title.title = session.title;
    title.setAttribute('role', 'cell');

    const project = document.createElement('span');
    project.className = 'an-session-project';
    project.textContent = session.projectLabel;
    project.setAttribute('role', 'cell');

    const tokens = document.createElement('span');
    tokens.className = 'an-session-tokens';
    tokens.textContent = `${formatCompactNumber(session.tokens)} tokens`;
    tokens.title = formatFullNumber(session.tokens);
    tokens.setAttribute('role', 'cell');

    const cost = document.createElement('span');
    cost.className = 'an-session-cost';
    cost.textContent = formatUsd(session.cost);
    cost.setAttribute('role', 'cell');

    const activity = document.createElement('span');
    activity.className = 'an-session-activity';
    activity.textContent = new Date(session.lastActivity).toLocaleDateString();
    activity.setAttribute('role', 'cell');

    row.append(title, project, tokens, cost, activity);
    grid.append(row);
  }

  root.append(grid);
  root.append(errorLine);
}

/** Wires session activation through the host bridge with a safe failure note. */
export function bindSessionNavigation(
  root: HTMLElement,
  openSession: (sessionId: string) => Promise<void>,
): () => void {
  const onClick = (event: Event): void => {
    const target = (event.target as HTMLElement).closest('[data-session-row]') as HTMLElement | null;
    const row = target ?? ((event.currentTarget as HTMLElement).matches('[data-session-row]') ? (event.currentTarget as HTMLElement) : null);

    if (!row) {
      return;
    }

    const sessionId = row.dataset['sessionId'];

    if (!sessionId) {
      return;
    }

    void openSession(sessionId).catch(() => {
      const errorLine = root.querySelector('[data-session-error]');

      if (errorLine) {
        errorLine.textContent = 'Opening this session is unavailable right now. Use the session list in OpenChamber to navigate.';
      }
    });
  };

  const onKeyDown = (event: Event): void => {
    const key = (event as KeyboardEvent).key;

    if (key === 'Enter' || key === ' ') {
      if ((event.target as HTMLElement).closest('[data-session-row]')) {
        event.preventDefault();
      }
      onClick(event);
    }
  };

  root.addEventListener('click', onClick);
  root.addEventListener('keydown', onKeyDown);

  return () => {
    root.removeEventListener('click', onClick);
    root.removeEventListener('keydown', onKeyDown);
  };
}
