import type { Coverage, Precision } from '../shared/analytics-types';
import type { SurfaceStatus } from '../shared/surface-controller';
import { createButtonControl } from './controls';

export type SyncStatusState = {
  status: SurfaceStatus;
  precision?: Precision;
  coverage?: Coverage;
  refreshing?: boolean;
  onRefresh?: () => void;
};

export const PRECISION_LABELS: Record<Precision, string> = {
  exact: 'Exact',
  partial: 'Partial',
  estimated: 'Estimated',
};

/** Human-readable coverage explanation; always mentions pending counts. */
export function coverageSummary(coverage: Coverage): string {
  return [
    `${coverage.complete} complete`,
    `${coverage.pending} pending`,
    coverage.residual > 0 ? `${coverage.residual} with estimated residual` : null,
    coverage.failed > 0 ? `${coverage.failed} failed` : null,
    coverage.mismatch > 0 ? `${coverage.mismatch} mismatched` : null,
    `of ${coverage.total} relevant sessions`,
  ]
    .filter((part) => part !== null)
    .join(', ');
}

/** Pill that names the data precision and explains coverage on hover. */
export function createPrecisionBadge(precision: Precision, coverage?: Coverage): HTMLElement {
  const badge = document.createElement('span');
  badge.className = 'an-sync-badge';
  badge.dataset['precision'] = precision;
  badge.textContent = PRECISION_LABELS[precision];

  if (coverage) {
    const summary = coverageSummary(coverage);
    badge.title = summary;
    badge.setAttribute('aria-label', `${PRECISION_LABELS[precision]}: ${summary}`);
  }

  return badge;
}

/**
 * Renders the precision indicator and the refresh control (with a progress
 * state). Re-renders in place; failure messaging is a separate banner.
 */
export function renderSyncStatus(container: HTMLElement, state: SyncStatusState): void {
  container.textContent = '';

  if (state.precision) {
    const badge = createPrecisionBadge(state.precision, state.coverage);
    badge.dataset['syncStatus'] = '';
    container.append(badge);
  }

  const refreshing = state.refreshing === true;
  const refresh = createButtonControl({
    label: refreshing ? 'Refreshing…' : 'Refresh',
    loading: refreshing,
    onClick: () => state.onRefresh?.(),
  });

  const node = refresh.element.querySelector('button');
  if (node) {
    node.dataset['refresh'] = '';
  }

  container.append(refresh.element);
}
