import { applyThemeSnapshot } from '../shared/theme';
import { createHostBridge } from '../shared/host';
import { createPanelController } from './controller';
import { loadSurfacePreferences } from '../shared/preferences';
import '../ui/styles.css';

/**
 * Browser entry for the compact rail panel (classic-script sandboxed iframe).
 */
export async function bootPanel(): Promise<void> {
  const bridge = createHostBridge();
  const container = document.getElementById('app') ?? document.body;

  bridge.onReady((context) => {
    applyThemeSnapshot(context, document.documentElement);
  });

  const preferences = await loadSurfacePreferences(bridge.storage, 'panel');

  const controller = createPanelController({
    container,
    bridge,
    preferences,
    eventDebounceMs: 150,
  });

  controller.start();
}

void bootPanel();
