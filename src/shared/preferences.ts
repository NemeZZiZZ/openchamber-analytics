import type { AnalyticsMetric, AnalyticsRange, AnalyticsScope, AnalyticsSurface, ChartKind, SummaryView } from './analytics-types';

export type SurfacePreferences = {
  scope: AnalyticsScope;
  range: AnalyticsRange;
  metric: AnalyticsMetric;
  view: SummaryView;
  chart: ChartKind;
  /** Pinned project directory; undefined means All or follow-the-host scope. */
  directory?: string;
};

export const DEFAULT_PREFERENCES: Readonly<SurfacePreferences> = Object.freeze({
  scope: 'all',
  range: '30d',
  metric: 'tokens',
  view: 'daily',
  chart: 'bar',
});

/** Pre-split shared key; read once for migration, never written. */
export const LEGACY_PREFERENCES_KEY = 'analytics/preferences';

const SURFACE_PREFERENCES_PREFIX = 'analytics/preferences/';

export type PreferenceStorage = {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
};

const SCOPES: AnalyticsScope[] = ['all', 'project'];
const RANGES: AnalyticsRange[] = ['1d', '7d', '30d', '90d', 'all'];
const METRICS: AnalyticsMetric[] = ['tokens', 'cost', 'sessions', 'steps'];
const VIEWS: SummaryView[] = ['daily', 'total'];
const CHARTS: ChartKind[] = ['bar', 'line'];

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function optionalNonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Field-by-field validation: invalid stored values reset to the defaults. */
export function validatePreferences(input: unknown): SurfacePreferences {
  const raw = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};

  return {
    scope: oneOf(raw.scope, SCOPES, DEFAULT_PREFERENCES.scope),
    range: oneOf(raw.range, RANGES, DEFAULT_PREFERENCES.range),
    metric: oneOf(raw.metric, METRICS, DEFAULT_PREFERENCES.metric),
    view: oneOf(raw.view, VIEWS, DEFAULT_PREFERENCES.view),
    chart: oneOf(raw.chart, CHARTS, DEFAULT_PREFERENCES.chart),
    directory: optionalNonEmpty(raw.directory),
  };
}

/**
 * The page defaults to All projects; the compact rail panel defaults to the
 * current project, which is what it is opened next to.
 */
export function defaultPreferences(surface: AnalyticsSurface): SurfacePreferences {
  return surface === 'panel' ? { ...DEFAULT_PREFERENCES, scope: 'project' } : { ...DEFAULT_PREFERENCES };
}

/** Per-surface storage: the page and the panel remember their scope independently. */
export function preferencesKey(surface: AnalyticsSurface): string {
  return SURFACE_PREFERENCES_PREFIX + surface;
}

/**
 * Loads one surface's persisted preferences, resetting invalid values to the
 * defaults. A missing surface key falls back to the pre-split shared key once
 * so existing installations keep their choices.
 */
export async function loadSurfacePreferences(storage: PreferenceStorage, surface: AnalyticsSurface): Promise<SurfacePreferences> {
  try {
    const stored = await storage.get(preferencesKey(surface));

    if (stored !== undefined && stored !== null) {
      return validatePreferences(stored);
    }

    const legacy = await storage.get(LEGACY_PREFERENCES_KEY);

    if (legacy !== undefined && legacy !== null) {
      return validatePreferences(legacy);
    }
  } catch {
    // Fall through to the defaults; storage failures must not break the surface.
  }

  return defaultPreferences(surface);
}

/** Persists one surface's preferences; storage failures are non-fatal. */
export async function saveSurfacePreferences(storage: PreferenceStorage, surface: AnalyticsSurface, preferences: SurfacePreferences): Promise<void> {
  try {
    await storage.set(preferencesKey(surface), validatePreferences(preferences));
  } catch {
    // Host storage limits or transient failures must not break the surface.
  }
}
