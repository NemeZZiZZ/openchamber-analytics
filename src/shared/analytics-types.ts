/**
 * Shared analytics contracts.
 *
 * These DTOs cross the service → iframe boundary and are consumed by both
 * browser surfaces. This file must stay free of DOM and OpenCode transport
 * dependencies so the service and the iframes share one definition.
 *
 * Canonical timestamps are UTC epoch milliseconds. All token components are
 * finite nonnegative numbers normalized at the service trust boundary.
 */

export type TokenUsage = {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
};

export const EMPTY_TOKENS: Readonly<TokenUsage> = Object.freeze({
  input: 0,
  output: 0,
  reasoning: 0,
  cache: Object.freeze({ read: 0, write: 0 }),
});

/** All five components: input + output + reasoning + cache.read + cache.write. */
export function totalTokens(tokens: TokenUsage): number {
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write;
}

/** Total tokens of one usage event (all five components). */
export function eventTokens(event: { tokens: TokenUsage }): number {
  return totalTokens(event.tokens);
}

/** Normalized OpenCode session metadata (no raw conversation content). */
export type SessionRecord = {
  sessionId: string;
  title: string;
  directory: string;
  parentSessionId?: string;
  agent?: string;
  providerID?: string;
  modelID?: string;
  /** Model variant tier when the runtime provides one (max, high, default, …). */
  variant?: string;
  timeCreated: number;
  timeUpdated: number;
  /** Session-level aggregate usage when the runtime provides one; else null. */
  tokens: TokenUsage | null;
  /** Recorded USD cost from OpenCode; never recomputed from pricing. */
  cost: number | null;
  /** Terminal outcome once the runtime reports one. */
  outcome?: SessionOutcome;
};

export type SessionOutcome = 'succeeded' | 'failed' | 'interrupted';

export type UsageEventSource = 'assistant' | 'residual' | 'session-snapshot';

/**
 * Canonical allocation event. `session-snapshot` events are provisional
 * replacements produced while detailed history is unavailable; they are
 * replaced — never supplemented — by assistant/residual events.
 */
export type UsageEvent = {
  sessionId: string;
  timestamp: number;
  providerID?: string;
  modelID?: string;
  /** Model variant tier when the runtime provides one (max, high, default, …). */
  variant?: string;
  agent?: string;
  tokens: TokenUsage;
  cost: number;
  /** Assistant messages behind this allocation; 0 for provisional snapshots. */
  messageCount: number;
  source: UsageEventSource;
  estimated: boolean;
  /** Assistant message wall time (completed − created); absent when unknown. */
  durationMs?: number;
  /** Time to first token (firstToken − created); absent when unknown. */
  firstTokenMs?: number;
  /** Provider finish reason of the assistant message. */
  finish?: AssistantFinish;
  /** True when the message carries a structured error. */
  hasError?: boolean;
  /** Retry attempt number when the message was a provider retry. */
  retries?: number;
  toolCalls?: number;
  toolErrors?: number;
};

export type AssistantFinish = 'stop' | 'length' | 'tool-calls' | 'content-filter' | 'error' | 'unknown';

export type SessionSyncState = 'pending' | 'complete' | 'failed' | 'mismatch';

export type StoredSessionAnalytics = {
  sessionId: string;
  session: SessionRecord;
  fingerprint: string;
  state: SessionSyncState;
  attempts: number;
  lastError?: string;
  syncedAt?: number;
  events: UsageEvent[];
};

export type AnalyticsScope = 'all' | 'project';
export type AnalyticsRange = '1d' | '7d' | '30d' | '90d' | 'all';
export type AnalyticsSurface = 'page' | 'panel';
export type AnalyticsMetric = 'tokens' | 'cost' | 'sessions' | 'steps';
export type SummaryView = 'daily' | 'total';
export type ChartKind = 'bar' | 'line';

export type AnalyticsFilters = {
  scope: AnalyticsScope;
  directory?: string;
  range: AnalyticsRange;
  surface: AnalyticsSurface;
  timeZone: string;
};

export type Precision = 'estimated' | 'partial' | 'exact';

export type Coverage = {
  complete: number;
  residual: number;
  pending: number;
  failed: number;
  mismatch: number;
  total: number;
};

export type SummaryMetrics = {
  tokens: number;
  cost: number;
  sessions: number;
  /** Distinct sessions with a parent in the period (subagents). */
  subagents: number;
  /** Assistant steps (model calls) in the period; 0 while provisional. */
  prompts: number;
  activeDays: number;
  avgTokensPerActiveDay: number;
  avgTokensPerWeek: number;
  currentStreak: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheHitRate: number;
  reasoningShare: number;
  costPerMillion: number;
  costPerSession: number;
  tokensPerSession: number;
};

export type TokenBreakdownComponent =
  | 'input'
  | 'output'
  | 'reasoning'
  | 'cacheRead'
  | 'cacheWrite';

export type ModelDailyValue = {
  modelKey: string;
  tokens: number;
  cost: number;
};

/** One local calendar day bucket; zero days are always present. */
export type DailyBucket = {
  day: string;
  tokens: number;
  cost: number;
  sessions: number;
  /** Assistant steps (model calls) this day; 0 while provisional. */
  steps: number;
  breakdown: Record<TokenBreakdownComponent, number>;
  /** Per-model allocation used by stacked daily series. */
  models: ModelDailyValue[];
};

export type BreakdownSeries = {
  key: TokenBreakdownComponent;
  label: string;
  points: { day: string; value: number }[];
};

export type PromptCachingSeries = {
  key: 'uncachedInput' | 'cacheRead';
  label: string;
  points: { day: string; value: number }[];
};

export type ModelAggregate = {
  modelKey: string;
  providerID?: string;
  modelID?: string;
  /** Model variant tier when known (max, high, default, …). */
  variant?: string;
  tokens: number;
  cost: number;
  reasoningTokens: number;
  /** Assistant steps behind this model; 0 while provisional. */
  steps: number;
  /** Distinct sessions containing this model; overlaps across models. */
  sessions: number;
  /** Share of attributed model tokens (may be omitted for Other aggregates). */
  share?: number;
};

export type AgentAggregate = {
  agent: string;
  tokens: number;
  cost: number;
  sessions: number;
};

export type TopSession = {
  sessionId: string;
  title: string;
  projectLabel: string;
  directory: string;
  tokens: number;
  cost: number;
  lastActivity: number;
};

export type TopProject = {
  label: string;
  directory: string;
  tokens: number;
  cost: number;
  lastActivity: number;
  /** Distinct sessions with events in this project; overlaps per period. */
  sessions: number;
};

export type ActivityDayCell = {
  day: string;
  tokens: number;
  /** 0–4 intensity relative to the grid maximum. */
  level: 0 | 1 | 2 | 3 | 4;
  /** Accessible label including the formatted token value. */
  label: string;
};

export type ActivityViewModel = {
  /** Ascending last-12-month day cells (local days, including zeros). */
  cells: ActivityDayCell[];
  longestStreak: number;
  avgTokensPerActiveDay: number;
  avgTokensPerWeek: number;
  totalTokens: number;
};

export type EfficiencyViewModel = {
  costPerMillion: number;
  costPerSession: number;
  tokensPerSession: number;
  /** Assistant steps per session; 0 while provisional. */
  stepsPerSession: number;
  reasoningShare: number;
  /** Wall-clock session spans (updated - created) in milliseconds. */
  avgSessionSpan: number;
  medianSessionSpan: number;
  longestSessionSpan: number;
  /** failed / sessions with a terminal outcome in the window; 0 without any. */
  failedSessionRate: number;
  failedSessions: number;
  interruptedSessions: number;
  sessionsWithOutcome: number;
};

/**
 * Response-quality metrics derived from assistant message timing, finish
 * reasons and tool parts. Only messages that carry the relevant data count;
 * `samples` is the number of timed assistant steps behind the latencies.
 */
export type QualityViewModel = {
  /** Assistant steps with timing data. */
  samples: number;
  avgLatencyMs: number;
  medianLatencyMs: number;
  p95LatencyMs: number;
  avgFirstTokenMs: number;
  /** Output tokens per second of streaming time (completed − firstToken). */
  outputTokensPerSecond: number;
  /** Assistant steps with finish information. */
  finished: number;
  errorRate: number;
  retryRate: number;
  /** Share of steps cut by the output limit (finish === 'length'). */
  truncatedRate: number;
  toolCalls: number;
  toolErrorRate: number;
  /** Faster/slower models by streaming speed (min 3 timed steps). */
  modelSpeeds: { modelKey: string; samples: number; outputTokensPerSecond: number; avgLatencyMs: number }[];
};

/** Spend pace over the period and a month-end projection. */
export type BurnViewModel = {
  /** Average over elapsed local days of the period window. */
  costPerDay: number;
  tokensPerDay: number;
  monthToDateCost: number;
  monthToDateTokens: number;
  projectedMonthCost: number;
  projectedMonthTokens: number;
  /** Days whose tokens exceed median + 3·MAD of the period's nonzero days. */
  anomalyDays: { day: string; tokens: number; cost: number }[];
};

/** Stream occurrences worth counting; raw payloads are never kept. */
export type CounterKind =
  | 'executionFailed'
  | 'executionInterrupted'
  | 'compaction'
  | 'retryScheduled'
  | 'permissionAsked'
  | 'permissionReplied'
  | 'permissionWait';

/** One counted occurrence; `ms` only on permissionWait (asked → replied). */
export type CounterEvent = {
  kind: CounterKind;
  sessionID: string;
  timestamp: number;
  ms?: number;
};

/** Per-day counters used by the reliability chart series. */
export type CounterDay = {
  day: string;
  executionFailed: number;
  executionInterrupted: number;
  compactions: number;
  retries: number;
  permissions: number;
};

/**
 * Reliability counters from the OpenCode event stream. Coverage is only as
 * good as the stream: occurrences while the service was down are missing, and
 * history starts when the counters file first appears.
 */
export type EventCountersViewModel = {
  executionFailed: number;
  executionInterrupted: number;
  compactions: number;
  retries: number;
  permissionAsks: number;
  /** Average asked → replied latency in milliseconds; 0 without pairs. */
  avgPermissionWaitMs: number;
  /** Zero-filled per-local-day series across the period window. */
  daily: CounterDay[];
};


/** One 7×24 Activity Rhythm cell (local weekday × local hour). */
export type RhythmCell = {
  weekday: number;
  hour: number;
  tokens: number;
  level: 0 | 1 | 2 | 3 | 4;
  /** Tooltip/accessible label: weekday, hour, and formatted token value. */
  label: string;
  /** The local dates this weekday covers in the window ("2 Nov – 9 Nov"); absent in older services. */
  dates?: string;
};

/**
 * One distinct project directory known to the service, aggregated over all
 * time. Powers the project picker on both surfaces; the list ignores the
 * active filters so a scoped view still offers every project.
 */
export type ProjectEntry = {
  directory: string;
  label: string;
  sessions: number;
  tokens: number;
  cost: number;
};

export type AnalyticsSnapshot = {
  schemaVersion: 1;
  revision: number;
  generatedAt: number;
  timeZone: string;
  filters: AnalyticsFilters;
  precision: Precision;
  periodPrecision: {
    current: Precision;
    previous?: Precision;
  };
  coverage: Coverage;
  summary: SummaryMetrics;
  daily: DailyBucket[];
  previous?: SummaryMetrics;
  activity: ActivityViewModel;
  /** 7 local weekdays × 24 local hours token rhythm over the period. */
  rhythm: RhythmCell[];
  efficiency: EfficiencyViewModel;
  /** Absent in snapshots from older services. */
  quality?: QualityViewModel;
  burn?: BurnViewModel;
  /** Reliability counters; absent in snapshots from older services. */
  counters?: EventCountersViewModel;
  models: ModelAggregate[];
  /** Sessions donut via primary-model assignment (spec §7.6); sums to distinct sessions. */
  sessionDonut: ModelAggregate[];
  agents: AgentAggregate[];
  topSessions: TopSession[];
  /** Projects ranked by cost then tokens for the period; page-only use. */
  /** Absent while an older keepRunning service serves the snapshot. */
  topProjects?: TopProject[];
  /** Distinct project directories across all data; absent in older services. */
  projects?: ProjectEntry[];
};

/** Service change/progress notification payloads (no history, no chart arrays). */
export type AnalyticsServiceEvent =
  | { topic: 'analytics:changed'; data: { revision: number } }
  | { topic: 'analytics:progress'; data: { revision: number; coverage: Coverage } };

/**
 * Local calendar period bounds. `startDay`/`endDay` are local YYYY-MM-DD keys;
 * `startMs`/`endMs` are exact UTC bounds of the local day boundaries.
 * `dayCount` is the actual number of local calendar days in the window.
 */
export type PeriodBounds = {
  startDay: string;
  endDay: string;
  startMs: number;
  endMs: number;
  dayCount: number;
};

export type PeriodWindow = PeriodBounds & {
  range: AnalyticsRange;
  /** Immediately preceding N local days; absent for All time. */
  previous?: PeriodBounds;
};
