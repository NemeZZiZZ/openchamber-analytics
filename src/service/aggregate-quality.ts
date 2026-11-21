import type {
  BurnViewModel,
  DailyBucket,
  PeriodBounds,
  QualityViewModel,
  UsageEvent,
} from '../shared/analytics-types';
import { eventTokens } from '../shared/analytics-types';
import { eventModelKey } from './aggregate-core';
import { localMidnightMs } from './time';

const MODEL_SPEED_MIN_SAMPLES = 3;
const MODEL_SPEED_LIMIT = 8;
const ANOMALY_MAD_FACTOR = 3;
const ANOMALY_MIN_DAYS = 7;
const ANOMALY_LIMIT = 10;

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : sum(values) / values.length;
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) {
    return 0;
  }

  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));

  return sorted[index] ?? 0;
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 1 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/** Streaming speed of one message; needs a positive stream window and output. */
function streamingSpeed(event: UsageEvent): number | null {
  if (event.durationMs === undefined || event.firstTokenMs === undefined) {
    return null;
  }

  const streamMs = event.durationMs - event.firstTokenMs;
  const output = event.tokens.output + event.tokens.reasoning;

  if (streamMs <= 0 || output <= 0) {
    return null;
  }

  return output / (streamMs / 1000);
}

/**
 * Response-quality metrics over windowed assistant events. Provisional and
 * residual events carry no timing facts and are ignored here.
 */
export function computeQuality(periodEvents: UsageEvent[]): QualityViewModel {
  const assistant = periodEvents.filter((event) => event.source === 'assistant');
  const latencies: number[] = [];
  const firstTokens: number[] = [];
  let outputTokens = 0;
  let streamSeconds = 0;
  let finished = 0;
  let errors = 0;
  let retries = 0;
  let truncated = 0;
  let toolCalls = 0;
  let toolErrors = 0;
  const models = new Map<string, { samples: number; output: number; seconds: number; latency: number }>();

  for (const event of assistant) {
    if (event.durationMs !== undefined) {
      latencies.push(event.durationMs);
    }

    if (event.firstTokenMs !== undefined) {
      firstTokens.push(event.firstTokenMs);
    }

    const speed = streamingSpeed(event);

    if (speed !== null && event.durationMs !== undefined && event.firstTokenMs !== undefined) {
      const seconds = (event.durationMs - event.firstTokenMs) / 1000;
      const output = event.tokens.output + event.tokens.reasoning;
      outputTokens += output;
      streamSeconds += seconds;
      const key = eventModelKey(event);
      const entry = models.get(key) ?? { samples: 0, output: 0, seconds: 0, latency: 0 };
      entry.samples += 1;
      entry.output += output;
      entry.seconds += seconds;
      entry.latency += event.durationMs;
      models.set(key, entry);
    }

    if (event.finish !== undefined) {
      finished += 1;

      if (event.finish === 'length') {
        truncated += 1;
      }
    }

    if (event.finish === 'error' || event.hasError === true) {
      errors += 1;
    }

    if ((event.retries ?? 0) > 0) {
      retries += 1;
    }

    toolCalls += event.toolCalls ?? 0;
    toolErrors += event.toolErrors ?? 0;
  }

  const sortedLatencies = [...latencies].sort((a, b) => a - b);
  const observed = Math.max(finished, assistant.filter((event) => event.hasError !== undefined).length);

  return {
    samples: latencies.length,
    avgLatencyMs: mean(latencies),
    medianLatencyMs: median(latencies),
    p95LatencyMs: percentile(sortedLatencies, 0.95),
    avgFirstTokenMs: mean(firstTokens),
    outputTokensPerSecond: streamSeconds > 0 ? outputTokens / streamSeconds : 0,
    finished,
    errorRate: observed > 0 ? errors / observed : 0,
    retryRate: observed > 0 ? retries / observed : 0,
    truncatedRate: finished > 0 ? truncated / finished : 0,
    toolCalls,
    toolErrorRate: toolCalls > 0 ? toolErrors / toolCalls : 0,
    modelSpeeds: [...models.entries()]
      .filter(([, entry]) => entry.samples >= MODEL_SPEED_MIN_SAMPLES)
      .map(([modelKey, entry]) => ({
        modelKey,
        samples: entry.samples,
        outputTokensPerSecond: entry.output / entry.seconds,
        avgLatencyMs: entry.latency / entry.samples,
      }))
      .sort((a, b) => b.outputTokensPerSecond - a.outputTokensPerSecond || a.modelKey.localeCompare(b.modelKey))
      .slice(0, MODEL_SPEED_LIMIT),
  };
}

function daysInMonth(day: string): number {
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));

  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Spend pace for the period plus a linear month-end projection from the
 * current local month, and statistically unusual days (median + 3·MAD over
 * the period's active days).
 */
export function computeBurn(
  events: UsageEvent[],
  daily: DailyBucket[],
  window: PeriodBounds,
  timeZone: string,
  periodTotals: { tokens: number; cost: number },
): BurnViewModel {
  const dayCount = Math.max(1, window.dayCount);
  const monthStartDay = `${window.endDay.slice(0, 7)}-01`;
  const monthStartMs = localMidnightMs(monthStartDay, timeZone);
  let monthCost = 0;
  let monthTokens = 0;

  for (const event of events) {
    if (event.timestamp >= monthStartMs && event.timestamp <= window.endMs) {
      monthCost += event.cost;
      monthTokens += eventTokens(event);
    }
  }

  const elapsed = Math.max(1, Number(window.endDay.slice(8, 10)));
  const monthDays = daysInMonth(window.endDay);
  const active = daily.filter((bucket) => bucket.tokens > 0);
  let anomalyDays: BurnViewModel['anomalyDays'] = [];

  if (active.length >= ANOMALY_MIN_DAYS) {
    const tokens = active.map((bucket) => bucket.tokens);
    const center = median(tokens);
    const mad = median(tokens.map((value) => Math.abs(value - center)));
    const threshold = center + ANOMALY_MAD_FACTOR * Math.max(mad, 1) * 1.4826;

    anomalyDays = active
      .filter((bucket) => bucket.tokens > threshold)
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, ANOMALY_LIMIT)
      .map((bucket) => ({ day: bucket.day, tokens: bucket.tokens, cost: bucket.cost }));
  }

  return {
    costPerDay: periodTotals.cost / dayCount,
    tokensPerDay: periodTotals.tokens / dayCount,
    monthToDateCost: monthCost,
    monthToDateTokens: monthTokens,
    projectedMonthCost: (monthCost / elapsed) * monthDays,
    projectedMonthTokens: (monthTokens / elapsed) * monthDays,
    anomalyDays,
  };
}
