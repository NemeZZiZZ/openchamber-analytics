import { applyHostReady } from '@openchamber/sdk/ui';
import type { HostReadyContext } from '@openchamber/sdk';

/**
 * Writes host theme tokens (including `--oc-*` aliases) and surface/theme
 * data attributes onto the surface root. Safe to call on every repeated
 * `host.onReady()` snapshot: the SDK writes variables in place and never
 * duplicates listeners or stylesheet state.
 */
export function applyThemeSnapshot(context: HostReadyContext, root: HTMLElement): void {
  applyHostReady(context, root);
}
