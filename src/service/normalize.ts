import type { AssistantFinish, SessionRecord, TokenUsage, UsageEvent } from '../shared/analytics-types';
import { EMPTY_TOKENS, totalTokens } from '../shared/analytics-types';

/** Cost comparison epsilon: floating-point sums may drift by tiny amounts. */
const COST_EPSILON = 1e-9;

/**
 * Normalizes an unknown numeric value to a finite nonnegative number.
 * Malformed, negative, NaN, and infinite values clamp to zero.
 */
function nonNegativeNumber(input: unknown): number {
  if (typeof input !== 'number' || !Number.isFinite(input) || input <= 0) {
    return 0;
  }

  return input;
}

/** Absent/invalid numbers read as missing so "no data" stays distinct from zero. */
function optionalNumber(input: unknown): number | null {
  if (typeof input !== 'number' || !Number.isFinite(input)) {
    return null;
  }

  return Math.max(0, input);
}

function normalizeTokens(input: unknown): TokenUsage | null {
  if (input === null || input === undefined) {
    return null;
  }

  if (typeof input !== 'object') {
    return null;
  }

  const raw = input as Record<string, unknown>;
  const cache = typeof raw.cache === 'object' && raw.cache !== null ? (raw.cache as Record<string, unknown>) : {};

  return {
    input: nonNegativeNumber(raw.input),
    output: nonNegativeNumber(raw.output),
    reasoning: nonNegativeNumber(raw.reasoning),
    cache: {
      read: nonNegativeNumber(cache.read),
      write: nonNegativeNumber(cache.write),
    },
  };
}

function nonEmptyString(input: unknown): string | undefined {
  if (typeof input !== 'string' || input.trim() === '') {
    return undefined;
  }

  return input;
}

/**
 * Normalizes a raw OpenCode session record. Returns null for malformed session
 * identity (missing id or unusable timestamps) rather than fabricating a
 * session. Absent usage/model metadata stays absent so provisional fallbacks
 * remain visible instead of silently reading as zero usage.
 */
export function normalizeSession(input: unknown): SessionRecord | null {
  if (input === null || typeof input !== 'object') {
    return null;
  }

  const raw = input as Record<string, unknown>;
  const sessionId = nonEmptyString(raw.id);

  if (!sessionId) {
    return null;
  }

  const time = typeof raw.time === 'object' && raw.time !== null ? (raw.time as Record<string, unknown>) : {};
  const timeCreatedRaw = optionalNumber(time.created);
  const timeUpdatedRaw = optionalNumber(time.updated);

  if (timeCreatedRaw === null) {
    return null;
  }

  const timeCreated = timeCreatedRaw;
  const timeUpdated = timeUpdatedRaw ?? timeCreated;

  const title = typeof raw.title === 'string' && raw.title.trim() !== '' ? raw.title : 'Untitled session';

  const location =
    typeof raw.location === 'object' && raw.location !== null ? (raw.location as Record<string, unknown>) : {};
  const directory = nonEmptyString(location.directory) ?? nonEmptyString(raw.directory) ?? '';

  const model = typeof raw.model === 'object' && raw.model !== null ? (raw.model as Record<string, unknown>) : {};

  return {
    sessionId,
    title,
    directory,
    parentSessionId: nonEmptyString(raw.parentID),
    agent: nonEmptyString(raw.agent),
    providerID: nonEmptyString(model.providerID) ?? nonEmptyString(raw.providerID),
    modelID: nonEmptyString(model.id) ?? nonEmptyString(raw.modelID),
    variant: nonEmptyString(model.variant) ?? nonEmptyString(raw.variant),
    timeCreated,
    timeUpdated,
    tokens: normalizeTokens(raw.tokens),
    cost: optionalNumber(raw.cost),
    outcome:
      raw.outcome === 'succeeded' || raw.outcome === 'failed' || raw.outcome === 'interrupted'
        ? raw.outcome
        : undefined,
  };
}

/**
 * A changed fingerprint invalidates previous detailed allocations. It covers
 * time.updated, aggregate usage, cost, and model identity; analytics-irrelevant
 * metadata (titles) does not participate.
 */
export function sessionFingerprint(session: SessionRecord): string {
  return JSON.stringify([
    session.timeUpdated,
    session.cost,
    session.tokens,
    session.providerID,
    session.modelID,
    session.variant,
    session.agent,
  ]);
}

function messageTimestamp(input: Record<string, unknown>): number | null {
  const time = typeof input.time === 'object' && input.time !== null ? (input.time as Record<string, unknown>) : {};
  return optionalNumber(time.created);
}

/**
 * Normalizes one raw assistant message into a usage event at its own
 * message timestamp. Returns null for anything that is not a usable assistant
 * message; dropped usage is recovered through residual reconciliation.
 */
export function normalizeAssistantEvent(session: SessionRecord, input: unknown): UsageEvent | null {
  if (input === null || typeof input !== 'object') {
    return null;
  }

  const raw = input as Record<string, unknown>;

  if (raw.type !== 'assistant') {
    return null;
  }

  const timestamp = messageTimestamp(raw);

  if (timestamp === null) {
    return null;
  }

  const model = typeof raw.model === 'object' && raw.model !== null ? (raw.model as Record<string, unknown>) : {};
  const tokens = normalizeTokens(raw.tokens) ?? { ...EMPTY_TOKENS, cache: { ...EMPTY_TOKENS.cache } };

  return {
    sessionId: session.sessionId,
    timestamp,
    providerID: nonEmptyString(model.providerID) ?? nonEmptyString(raw.providerID),
    modelID: nonEmptyString(model.id) ?? nonEmptyString(raw.modelID),
    variant: nonEmptyString(model.variant) ?? nonEmptyString(raw.variant),
    agent: nonEmptyString(raw.agent) ?? session.agent,
    tokens,
    cost: nonNegativeNumber(raw.cost),
    messageCount: 1,
    source: 'assistant',
    estimated: false,
    ...assistantQuality(raw, timestamp),
  };
}

const FINISH_REASONS: readonly AssistantFinish[] = ['stop', 'length', 'tool-calls', 'content-filter', 'error', 'unknown'];

/**
 * Timing, finish and tool facts of one assistant message. Only numbers and
 * enums leave this function; message content is never retained.
 */
function assistantQuality(raw: Record<string, unknown>, created: number): Partial<UsageEvent> {
  const quality: Partial<UsageEvent> = {};
  const time = typeof raw.time === 'object' && raw.time !== null ? (raw.time as Record<string, unknown>) : {};
  const completed = optionalNumber(time.completed);
  const firstToken = optionalNumber(time.firstToken);

  if (completed !== null && completed >= created) {
    quality.durationMs = completed - created;
  }

  if (firstToken !== null && firstToken >= created) {
    quality.firstTokenMs = firstToken - created;
  }

  if (typeof raw.finish === 'string' && (FINISH_REASONS as readonly string[]).includes(raw.finish)) {
    quality.finish = raw.finish as AssistantFinish;
  }

  quality.hasError = raw.error !== undefined && raw.error !== null;

  const retry = typeof raw.retry === 'object' && raw.retry !== null ? (raw.retry as Record<string, unknown>) : null;

  if (retry !== null) {
    quality.retries = Math.max(1, Math.trunc(nonNegativeNumber(retry.attempt)));
  }

  if (Array.isArray(raw.content)) {
    let toolCalls = 0;
    let toolErrors = 0;

    for (const part of raw.content) {
      if (part === null || typeof part !== 'object' || (part as Record<string, unknown>).type !== 'tool') {
        continue;
      }

      toolCalls += 1;
      const state = (part as Record<string, unknown>).state;

      if (state !== null && typeof state === 'object' && (state as Record<string, unknown>).status === 'error') {
        toolErrors += 1;
      }
    }

    quality.toolCalls = toolCalls;
    quality.toolErrors = toolErrors;
  }

  return quality;
}

/**
 * The provisional allocation for a session whose detailed history is not yet
 * available (pending, failed, or mismatched). Zero-usage sessions with no
 * recorded activity produce no event.
 */
export function snapshotEvent(session: SessionRecord): UsageEvent | null {
  const tokens = session.tokens ?? { ...EMPTY_TOKENS, cache: { ...EMPTY_TOKENS.cache } };
  const cost = session.cost ?? 0;

  if (totalTokens(tokens) === 0 && cost < COST_EPSILON) {
    return null;
  }

  return {
    sessionId: session.sessionId,
    timestamp: session.timeUpdated,
    providerID: session.providerID,
    modelID: session.modelID,
    variant: session.variant,
    agent: session.agent,
    tokens,
    cost,
    messageCount: 0,
    source: 'session-snapshot',
    estimated: true,
  };
}

export const COST_TOLERANCE = COST_EPSILON;
