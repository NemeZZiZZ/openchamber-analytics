import { describe, expect, it } from 'vitest';

import {
  defaultPreferences,
  LEGACY_PREFERENCES_KEY,
  loadSurfacePreferences,
  preferencesKey,
  saveSurfacePreferences,
  type PreferenceStorage,
  type SurfacePreferences,
} from '../../src/shared/preferences';

function memoryStorage(initial: Record<string, unknown> = {}): PreferenceStorage & { data: Map<string, unknown>; sets: number } {
  const data = new Map<string, unknown>(Object.entries(initial));
  const storage = {
    data,
    sets: 0,
    async get(key: string) {
      return data.get(key);
    },
    async set(key: string, value: unknown) {
      data.set(key, value);
      storage.sets += 1;
    },
  };
  return storage;
}

const PAGE_PREFS: SurfacePreferences = { scope: 'all', range: '30d', metric: 'tokens', view: 'daily', chart: 'bar' };

describe('preferencesKey', () => {
  it('namespaces storage by surface', () => {
    expect(preferencesKey('page')).toBe('analytics/preferences/page');
    expect(preferencesKey('panel')).toBe('analytics/preferences/panel');
  });
});

describe('defaultPreferences', () => {
  it('defaults the page to all projects', () => {
    expect(defaultPreferences('page').scope).toBe('all');
  });

  it('defaults the panel to this project', () => {
    expect(defaultPreferences('panel').scope).toBe('project');
    expect(defaultPreferences('panel').directory).toBeUndefined();
  });
});

describe('loadSurfacePreferences', () => {
  it('returns per-surface defaults for empty storage', async () => {
    const storage = memoryStorage();
    expect(await loadSurfacePreferences(storage, 'page')).toEqual(defaultPreferences('page'));
    expect(await loadSurfacePreferences(storage, 'panel')).toEqual(defaultPreferences('panel'));
  });

  it('rejects invalid stored values field by field', async () => {
    const storage = memoryStorage({
      [preferencesKey('page')]: {
        scope: 'galaxy',
        range: '15d',
        metric: 'unicorns',
        view: 'weekly',
        chart: 'pie',
        directory: 42,
      },
    });

    expect(await loadSurfacePreferences(storage, 'page')).toEqual(defaultPreferences('page'));
  });

  it('keeps valid stored values including the pinned directory', async () => {
    const storage = memoryStorage({
      [preferencesKey('page')]: {
        scope: 'project',
        range: '90d',
        metric: 'cost',
        view: 'total',
        chart: 'line',
        directory: '/repo/demo',
        evil: 'payload',
      },
    });

    expect(await loadSurfacePreferences(storage, 'page')).toEqual({
      scope: 'project',
      range: '90d',
      metric: 'cost',
      view: 'total',
      chart: 'line',
      directory: '/repo/demo',
    });
  });

  it('drops an empty pinned directory instead of failing', async () => {
    const storage = memoryStorage({
      [preferencesKey('panel')]: { ...PAGE_PREFS, scope: 'project', directory: '' },
    });

    const prefs = await loadSurfacePreferences(storage, 'panel');
    expect(prefs.scope).toBe('project');
    expect(prefs.directory).toBeUndefined();
  });

  it('migrates from the legacy shared key when the surface key is absent', async () => {
    const storage = memoryStorage({
      [LEGACY_PREFERENCES_KEY]: { scope: 'project', range: '7d', metric: 'cost', view: 'total', chart: 'line' },
    });

    expect(await loadSurfacePreferences(storage, 'page')).toEqual({
      scope: 'project',
      range: '7d',
      metric: 'cost',
      view: 'total',
      chart: 'line',
    });
    expect(await loadSurfacePreferences(storage, 'panel')).toEqual({
      scope: 'project',
      range: '7d',
      metric: 'cost',
      view: 'total',
      chart: 'line',
    });
  });

  it('prefers the surface key over the legacy shared key', async () => {
    const storage = memoryStorage({
      [LEGACY_PREFERENCES_KEY]: { scope: 'project', range: '7d', metric: 'cost', view: 'total', chart: 'line' },
      [preferencesKey('page')]: PAGE_PREFS,
    });

    expect(await loadSurfacePreferences(storage, 'page')).toEqual(PAGE_PREFS);
  });

  it('falls back to per-surface defaults when storage fails', async () => {
    const storage: PreferenceStorage = {
      async get() {
        throw new Error('storage unavailable');
      },
      async set() {
        throw new Error('storage unavailable');
      },
    };

    expect(await loadSurfacePreferences(storage, 'page')).toEqual(defaultPreferences('page'));
    expect(await loadSurfacePreferences(storage, 'panel')).toEqual(defaultPreferences('panel'));
  });
});

describe('saveSurfacePreferences', () => {
  it('persists all fields under the surface key without touching other surfaces', async () => {
    const storage = memoryStorage();
    const prefs: SurfacePreferences = {
      scope: 'project',
      range: '7d',
      metric: 'sessions',
      view: 'total',
      chart: 'bar',
      directory: '/repo/demo',
    };

    await saveSurfacePreferences(storage, 'page', prefs);

    expect(storage.sets).toBe(1);
    expect(storage.data.get(preferencesKey('page'))).toEqual(prefs);
    expect(storage.data.has(preferencesKey('panel'))).toBe(false);
    expect(await loadSurfacePreferences(storage, 'panel')).toEqual(defaultPreferences('panel'));
  });

  it('tolerates storage failures', async () => {
    const storage: PreferenceStorage = {
      async get() {
        return undefined;
      },
      async set() {
        throw new Error('read-only');
      },
    };

    await expect(saveSurfacePreferences(storage, 'page', PAGE_PREFS)).resolves.toBeUndefined();
  });
});
