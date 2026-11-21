import type { AnalyticsSnapshot } from '../../shared/analytics-types';
import { computeDelta, deltaPercentLabel, type Delta } from '../../shared/delta';
import { formatCompactNumber, formatDayLabel, formatFullNumber, formatLatency, formatPercent, formatSessionSpan, formatUsd, formatUsdExact } from '../../shared/formatting';
import { renderSparkline, type SparklineHandle } from '../../ui/charts/sparkline';
import { hostPalette } from '../../ui/charts/palette';
import type { SectionDeps } from '../page-types';

function sparklineValues(snapshot: AnalyticsSnapshot, pick: (bucket: AnalyticsSnapshot['daily'][number]) => number): number[] {
  return snapshot.daily.map((bucket) => pick(bucket));
}

function deltaBadge(container: HTMLElement, delta: Delta): void {
  const badge = document.createElement('span');
  badge.className = `an-delta an-delta-${delta.state}`;
  badge.textContent = deltaPercentLabel(delta);
  container.append(badge);
}

/** Compact subtitle under a card value, e.g. "In 350M · Out 29M · Cache 3.8B". */
function cardSubtitle(container: HTMLElement, text: string, full: string): void {
  const sub = document.createElement('span');
  sub.className = 'an-stat-subtitle';
  sub.textContent = text;
  sub.title = full;
  container.append(sub);
}

/**
 * Token composition strip: one stacked bar of input, output + reasoning,
 * cache reads, and cache writes with the value/percent legend, mirroring the
 * host Stats page.
 */
function renderTokenComposition(root: HTMLElement, summary: AnalyticsSnapshot['summary']): void {
  const heading = document.createElement('div');
  heading.className = 'an-activity-heading';
  heading.textContent = 'Token composition';
  root.append(heading);

  const parts = [
    { label: 'Input', value: summary.inputTokens, color: 'var(--oc-primary, var(--an-primary))' },
    { label: 'Output + reasoning', value: summary.outputTokens + summary.reasoningTokens, color: 'var(--oc-success, #34d399)' },
    { label: 'Cache reads', value: summary.cacheReadTokens, color: 'var(--oc-warning, #f5a623)' },
    { label: 'Cache writes', value: summary.cacheWriteTokens, color: 'var(--oc-error, #ef4444)' },
  ];
  const total = parts.reduce((acc, part) => acc + part.value, 0);

  const wrap = document.createElement('div');
  wrap.className = 'an-composition';
  wrap.dataset['composition'] = '';

  const bar = document.createElement('div');
  bar.className = 'an-composition-bar';
  bar.setAttribute('role', 'img');
  bar.setAttribute('aria-label', `Token composition: ${parts.map((part) => `${part.label} ${formatCompactNumber(part.value)}`).join(', ')}`);

  const legend = document.createElement('div');
  legend.className = 'an-composition-legend';

  for (const part of parts) {
    const share = total === 0 ? 0 : part.value / total;
    const segment = document.createElement('span');
    segment.className = 'an-composition-segment';
    segment.style.width = `${(share * 100).toFixed(2)}%`;
    segment.style.backgroundColor = part.color;
    bar.append(segment);

    const item = document.createElement('span');
    item.className = 'an-composition-item';

    const swatch = document.createElement('span');
    swatch.className = 'an-composition-swatch';
    swatch.style.backgroundColor = part.color;
    item.append(swatch);

    item.append(document.createTextNode(`${part.label} ${formatCompactNumber(part.value)} · ${formatPercent(share)}`));
    legend.append(item);
  }

  wrap.append(bar, legend);
  root.append(wrap);
}

/**
 * Overview cards: tokens (with the input/output/cache split), prompts,
 * sessions (with subagents), and cost, with sparklines and previous-period
 * deltas; cache hit rate with a sparkline; active days; the current day
 * streak; and the token composition strip.
 */
export function renderOverview(root: HTMLElement, deps: SectionDeps): void {
  root.textContent = '';
  const { snapshot, registry } = deps;
  const cards = document.createElement('div');
  cards.className = 'an-overview-grid';

  const dayLabels = snapshot.daily.map((bucket) => bucket.day);

  const buildCard = (
    label: string,
    value: string,
    full: string = value,
    spark?: number[],
    delta?: Delta,
    sparkFormat?: (value: number) => string,
    subtitle?: { text: string; full: string },
  ): void => {
    const card = document.createElement('div');
    card.className = 'an-overview-card';

    const labelEl = document.createElement('span');
    labelEl.className = 'an-stat-label';
    labelEl.textContent = label;

    const valueEl = document.createElement('span');
    valueEl.className = 'an-stat-value';
    valueEl.textContent = value;
    valueEl.setAttribute('aria-label', `${label}: ${full}`);
    valueEl.title = full;

    card.append(labelEl);

    const valueRow = document.createElement('div');
    valueRow.className = 'an-overview-value-row';
    valueRow.append(valueEl);

    // An unavailable previous period renders no badge at all: a bare "—" next
    // to the value is noise, not information (all time, provisional zero, …).
    if (delta && delta.state !== 'unavailable') {
      deltaBadge(valueRow, delta);
    }

    card.append(valueRow);

    if (subtitle) {
      cardSubtitle(card, subtitle.text, subtitle.full);
    }

    if (spark && spark.length > 1) {
      const sparkWrap = document.createElement('div');
      registry.track(
        renderSparkline(sparkWrap, {
          values: spark,
          labels: dayLabels,
          formatValue: sparkFormat,
          formatLabel: formatDayLabel,
          tooltipLabel: label,
          palette: hostPalette(),
          width: 120,
          height: 24,
          accessibleLabel: `${label} trend`,
        }) as SparklineHandle,
      );
      card.append(sparkWrap);
    }

    cards.append(card);
  };

  const previous = snapshot.previous;
  const previousPrecision = snapshot.periodPrecision.previous;
  const summary = snapshot.summary;

  const tokensSubtitle = `In ${formatCompactNumber(summary.inputTokens)} · Out ${formatCompactNumber(summary.outputTokens + summary.reasoningTokens)} · Cache ${formatCompactNumber(summary.cacheReadTokens + summary.cacheWriteTokens)}`;
  const tokensSubtitleFull = `Input ${formatFullNumber(summary.inputTokens)}, output ${formatFullNumber(summary.outputTokens)}, reasoning ${formatFullNumber(summary.reasoningTokens)}, cache reads ${formatFullNumber(summary.cacheReadTokens)}, cache writes ${formatFullNumber(summary.cacheWriteTokens)}`;

  buildCard(
    'Tokens',
    formatCompactNumber(summary.tokens),
    formatFullNumber(summary.tokens),
    sparklineValues(snapshot, (bucket) => bucket.tokens),
    computeDelta(summary.tokens, previous?.tokens, previousPrecision),
    formatFullNumber,
    { text: tokensSubtitle, full: tokensSubtitleFull },
  );

  buildCard(
    'Prompts',
    formatCompactNumber(summary.prompts),
    formatFullNumber(summary.prompts),
    sparklineValues(snapshot, (bucket) => bucket.steps),
    computeDelta(summary.prompts, previous?.prompts, previousPrecision),
    formatFullNumber,
    summary.prompts === 0
      ? { text: 'Steps arrive with detailed sync', full: 'Provisional snapshots carry no per-message steps yet' }
      : undefined,
  );

  const sessionsSubtitle = summary.subagents > 0
    ? { text: `Subagents: ${formatCompactNumber(summary.subagents)}`, full: `${formatFullNumber(summary.subagents)} subagent sessions in this period` }
    : undefined;

  buildCard(
    'Sessions',
    formatCompactNumber(summary.sessions),
    formatFullNumber(summary.sessions),
    sparklineValues(snapshot, (bucket) => bucket.sessions),
    computeDelta(summary.sessions, previous?.sessions, previousPrecision),
    formatFullNumber,
    sessionsSubtitle,
  );

  buildCard(
    'Cost',
    formatUsd(summary.cost),
    formatUsd(summary.cost),
    sparklineValues(snapshot, (bucket) => bucket.cost),
    computeDelta(summary.cost, previous?.cost, previousPrecision),
    formatUsd,
  );

  const hitRate = summary.cacheHitRate;
  buildCard(
    'Cache hit rate',
    `${Math.round(hitRate * 100)}%`,
    `${formatFullNumber(hitRate * 100, 'en-US')}% of input + cache reads`,
    sparklineValues(snapshot, (bucket) => (bucket.breakdown.input + bucket.breakdown.cacheRead > 0
      ? bucket.breakdown.cacheRead / (bucket.breakdown.input + bucket.breakdown.cacheRead)
      : 0)),
    undefined,
    (value) => `${formatFullNumber(value * 100, 'en-US')}%`,
  );

  buildCard('Active days', formatCompactNumber(summary.activeDays), formatFullNumber(summary.activeDays));
  buildCard('Current streak', `${summary.currentStreak}d`);

  root.append(cards);
  renderTokenComposition(root, summary);
}

/**
 * Efficiency cards. Spans are wall-clock session spans (updated − created)
 * and can include idle time — always labeled as span, never active work.
 */
export function renderEfficiency(root: HTMLElement, deps: SectionDeps): void {
  root.textContent = '';
  const { snapshot } = deps;
  const efficiency = snapshot.efficiency;

  const grid = document.createElement('div');
  grid.className = 'an-efficiency-grid';

  const stat = (label: string, value: string, full?: string): void => {
    const card = document.createElement('div');
    card.className = 'an-stat-card an-efficiency-card';
    const labelEl = document.createElement('span');
    labelEl.className = 'an-stat-label';
    labelEl.textContent = label;
    const valueEl = document.createElement('span');
    valueEl.className = 'an-stat-value';
    valueEl.textContent = value;

    if (full !== undefined) {
      valueEl.title = full;
    }

    valueEl.setAttribute('aria-label', `${label}: ${value}`);
    card.append(labelEl, valueEl);
    grid.append(card);
  };

  stat('Cost / M tokens', formatUsdExact(efficiency.costPerMillion));
  stat('Cost / session', formatUsdExact(efficiency.costPerSession));
  stat('Tokens / session', formatCompactNumber(efficiency.tokensPerSession), formatFullNumber(efficiency.tokensPerSession));
  stat(
    'Steps / session',
    formatCompactNumber(efficiency.stepsPerSession),
    efficiency.stepsPerSession === 0
      ? 'Assistant steps arrive with detailed sync'
      : `${formatFullNumber(efficiency.stepsPerSession)} assistant steps per session`,
  );
  stat('Reasoning share', `${Math.round(efficiency.reasoningShare * 100)}%`);
  stat('Avg session span', formatSessionSpan(efficiency.avgSessionSpan));
  stat('Median session span', formatSessionSpan(efficiency.medianSessionSpan));
  stat('Longest session span', formatSessionSpan(efficiency.longestSessionSpan));

  if (efficiency.sessionsWithOutcome > 0) {
    stat(
      'Failed sessions',
      formatPercent(efficiency.failedSessionRate),
      `${formatFullNumber(efficiency.failedSessions)} failed · ${formatFullNumber(efficiency.interruptedSessions)} interrupted of ${formatFullNumber(efficiency.sessionsWithOutcome)} finished`,
    );
  }

  const counters = snapshot.counters;

  if (counters !== undefined) {
    if (counters.executionFailed > 0) {
      stat('Stream errors', formatCompactNumber(counters.executionFailed), 'session.execution.failed events observed');
    }

    if (counters.compactions > 0) {
      stat('Compactions', formatCompactNumber(counters.compactions));
    }

    if (counters.avgPermissionWaitMs > 0) {
      stat('Avg permission wait', formatLatency(counters.avgPermissionWaitMs), `${formatFullNumber(counters.permissionAsks)} permission prompts`);
    }
  }

  const { quality, burn } = snapshot;

  if (quality !== undefined && quality.samples > 0) {
    stat('Median response', formatLatency(quality.medianLatencyMs), `p95 ${formatLatency(quality.p95LatencyMs)}`);
    stat('First token', formatLatency(quality.avgFirstTokenMs));
    stat(
      'Output speed',
      quality.outputTokensPerSecond > 0 ? `${formatCompactNumber(quality.outputTokensPerSecond)} tok/s` : '—',
    );
    stat('Error rate', formatPercent(quality.errorRate), `${formatPercent(quality.retryRate)} of steps were retried`);
    stat('Truncated', formatPercent(quality.truncatedRate), 'Steps cut by the output limit');

    if (quality.toolCalls > 0) {
      stat('Tool errors', formatPercent(quality.toolErrorRate), `${formatFullNumber(quality.toolCalls)} tool calls`);
    }
  }

  if (burn !== undefined) {
    stat('Cost / day', formatUsdExact(burn.costPerDay), `${formatCompactNumber(burn.tokensPerDay)} tokens per day`);
    stat('Month forecast', formatUsd(burn.projectedMonthCost), `${formatCompactNumber(burn.projectedMonthTokens)} tokens, linear projection`);

    if (burn.anomalyDays.length > 0) {
      stat(
        'Unusual days',
        String(burn.anomalyDays.length),
        burn.anomalyDays.map((day) => `${day.day}: ${formatCompactNumber(day.tokens)}`).join(', '),
      );
    }
  }

  root.append(grid);
}
