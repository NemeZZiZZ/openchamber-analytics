import { formatCompactNumber, formatDayLabel, formatFullNumber } from '../../shared/formatting';
import { renderYearHeatmap, type HeatmapHandle } from '../../ui/charts/heatmap-grid';
import { hostPalette } from '../../ui/charts/palette';
import { scrollToLatest } from '../../ui/charts/chart-shell';
import type { SectionDeps } from '../page-types';

/**
 * Activity: longest streak, period averages, and the independent last-12-month
 * grid (explicitly labeled, Monday-first, scrolled to the latest end).
 */
export function renderActivity(root: HTMLElement, deps: SectionDeps): void {
  root.textContent = '';
  const { snapshot, registry } = deps;

  const cards = document.createElement('div');
  cards.className = 'an-stat-cards';

  const stat = (label: string, value: string, full?: string): void => {
    const card = document.createElement('div');
    card.className = 'an-stat-card';
    const labelEl = document.createElement('span');
    labelEl.className = 'an-stat-label';
    labelEl.textContent = label;
    const valueEl = document.createElement('span');
    valueEl.className = 'an-stat-value';
    valueEl.textContent = value;

    if (full !== undefined) {
      valueEl.setAttribute('aria-label', `${label}: ${full}`);
      valueEl.title = full;
    }

    card.append(labelEl, valueEl);
    cards.append(card);
  };

  const activity = snapshot.activity;
  stat('Longest streak', `${activity.longestStreak}d`);
  stat('Avg / active day', formatCompactNumber(activity.avgTokensPerActiveDay), formatFullNumber(activity.avgTokensPerActiveDay));
  stat('Avg / week', formatCompactNumber(activity.avgTokensPerWeek), formatFullNumber(activity.avgTokensPerWeek));
  stat('Total tokens', formatCompactNumber(activity.totalTokens), formatFullNumber(activity.totalTokens));

  root.append(cards);

  const heading = document.createElement('div');
  heading.className = 'an-activity-heading';
  heading.textContent = 'Last 12 months';
  heading.setAttribute('aria-label', 'Daily activity over the last 12 months, independent of the selected period');
  root.append(heading);

  const scroller = document.createElement('div');
  scroller.className = 'an-year-scroller';
  scroller.dataset['yearScroller'] = '';
  root.append(scroller);

  const handle: HeatmapHandle = renderYearHeatmap(scroller, {
    cells: snapshot.activity.cells.map((cell) => ({
      day: cell.day,
      value: cell.tokens,
      level: cell.level,
      label: cell.label,
    })),
    palette: hostPalette(),
    formatValue: formatCompactNumber,
    formatLabel: formatDayLabel,
  });
  registry.track(handle);

  // The wide grid opens at its most recent end.
  requestAnimationFrame(() => scrollToLatest(scroller));
  scrollToLatest(scroller);
}
