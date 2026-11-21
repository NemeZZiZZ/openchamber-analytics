import type { AnalyticsSnapshot } from '../../shared/analytics-types';
import type { SurfaceStatus } from '../../shared/surface-controller';
import { mountBanner, mountEmpty } from '@openchamber/sdk/ui';

export type PageStateKind = 'first-zero' | 'no-filter-result' | 'service-down' | 'sync-failed';

/**
 * Distinct page states: a genuine empty workspace differs from an empty
 * filter result, an unreachable service differs from a failed sync, and a
 * failed refresh never erases the last good data (banner only).
 */
export function resolveStateBlock(
  snapshot: AnalyticsSnapshot | null,
  status: SurfaceStatus,
): PageStateKind | null {
  if (!snapshot) {
    if (status === 'error') {
      return 'service-down';
    }

    return null;
  }

  const empty = snapshot.summary.tokens === 0 && snapshot.summary.cost === 0 && snapshot.summary.sessions === 0;

  if (empty && snapshot.coverage.total === 0 && snapshot.precision === 'exact') {
    return 'first-zero';
  }

  if (empty && snapshot.coverage.total > 0) {
    return 'no-filter-result';
  }

  return null;
}

const STATE_COPY: Record<Exclude<PageStateKind, 'sync-failed'>, { title: string; body: string }> = {
  'first-zero': {
    title: 'No usage yet',
    body: 'This page fills in with token, cost, and session analytics once OpenCode records activity for your sessions.',
  },
  'no-filter-result': {
    title: 'No matching sessions',
    body: 'No sessions match this project and period. Try All projects or a longer period.',
  },
  'service-down': {
    title: 'Analytics service unreachable',
    body: 'Check that OpenChamber and OpenCode are running, then refresh.',
  },
};

/**
 * Renders a state block into `container` with the SDK kit: an empty state for
 * "nothing to show" kinds and a warning banner for a failed refresh. Returns a
 * disposer for the mounted kit nodes.
 */
export function renderStateBlock(container: HTMLElement, kind: PageStateKind): () => void {
  container.textContent = '';

  const block = document.createElement('div');
  block.className = kind === 'sync-failed' ? 'an-banner-wrap' : 'an-page-state';
  block.dataset['pageState'] = '';
  block.dataset['stateKind'] = kind;
  container.append(block);

  if (kind === 'sync-failed') {
    block.dataset['syncError'] = '';
    const banner = mountBanner(block, {
      tone: 'warning',
      title: 'Sync failed',
      body: 'Showing the last available data.',
    });
    return () => banner.dispose();
  }

  const copy = STATE_COPY[kind];
  const empty = mountEmpty(block, { title: copy.title, body: copy.body });
  return () => empty.dispose();
}
