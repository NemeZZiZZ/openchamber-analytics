import type { AnalyticsMetric, AnalyticsSnapshot, ChartKind, SummaryView } from '../shared/analytics-types';
import type { ChartHandle } from '../ui/charts/bar-chart';
import type { BrushHandle } from '../ui/charts/time-series-brush';
import type { HeatmapHandle } from '../ui/charts/heatmap-grid';
import type { SparklineHandle } from '../ui/charts/sparkline';

export type PageUiState = {
  metric: AnalyticsMetric;
  view: SummaryView;
  chart: ChartKind;
  /** Models leaderboard metric; session-bound, not persisted. */
  modelsMetric: AnalyticsMetric;
};

export type TrackableHandle = ChartHandle | BrushHandle | HeatmapHandle | SparklineHandle | { destroy(): void };

export type HandleRegistry = {
  track<T extends TrackableHandle>(handle: T): T;
  destroyAll(): void;
};

export function createHandleRegistry(): HandleRegistry {
  const handles: TrackableHandle[] = [];

  return {
    track(handle) {
      handles.push(handle);
      return handle;
    },
    destroyAll() {
      for (const handle of handles.splice(0)) {
        handle.destroy();
      }
    },
  };
}

export type SectionDeps = {
  snapshot: AnalyticsSnapshot;
  ui: PageUiState;
  registry: HandleRegistry;
};

/** Provider display names for the local, package-local metadata fallback. */
export const PROVIDER_LABELS: Record<string, string> = {
  zai: 'Z.ai',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  xai: 'xAI',
  deepseek: 'DeepSeek',
  qwen: 'Qwen',
  mistral: 'Mistral',
  meta: 'Meta',
};

const REASONING_PATTERN = /(^|\/)(o1|o3|o4|r1|deepseek-r1|reasoner|thinking)/i;

/** Reasoning indicator when the model identity is known to reason. */
export function isReasoningModel(modelID?: string): boolean {
  if (!modelID) {
    return false;
  }

  return REASONING_PATTERN.test(modelID) || /-thinking|thinking-/.test(modelID);
}

/** Friendly local label for a provider/model key; raw IDs are the fallback. */
export function modelDisplayName(providerID: string | undefined, modelID: string | undefined, modelKey: string): string {
  const provider = providerID ?? modelKey.split('/')[0] ?? 'unknown';
  const model = modelID ?? modelKey.split('/')[1] ?? 'unknown';
  const providerLabel = PROVIDER_LABELS[provider] ?? provider;
  return `${providerLabel} / ${model}`;
}
