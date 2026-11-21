import { applyThemeSnapshot } from '../shared/theme';
import { createHostBridge } from '../shared/host';
import { createPageController, type PageController } from './controller';
import { loadSurfacePreferences } from '../shared/preferences';
import '../ui/styles.css';

/**
 * Browser entry for the full Analytics page. Runs inside the sandboxed
 * classic-script iframe: connects to the host through the public SDK, applies
 * host theme tokens on every repeated ready snapshot, and hands rendering to
 * the page controller.
 */
export async function bootPage(): Promise<PageController> {
  const bridge = createHostBridge();
  const container = document.getElementById('app') ?? document.body;

  // Re-apply host tokens on every repeated ready snapshot.
  bridge.onReady((context) => {
    applyThemeSnapshot(context, document.documentElement);
  });

  const preferences = await loadSurfacePreferences(bridge.storage, 'page');

  const controller = createPageController({
    container,
    bridge,
    preferences,
    eventDebounceMs: 150,
  });

  return controller;
}

void bootPage();
