import type { SessionRecord, TokenUsage, UsageEvent } from '../shared/analytics-types';
import { EMPTY_TOKENS, totalTokens } from '../shared/analytics-types';
import { COST_TOLERANCE, normalizeAssistantEvent, snapshotEvent } from './normalize';

export type ReconciledSession = {
  state: 'complete' | 'mismatch';
  events: UsageEvent[];
  hasResidual: boolean;
};

type ComponentSums = {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
};

function emptySums(): ComponentSums {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function accumulate(sums: ComponentSums, event: UsageEvent): void {
  sums.input += event.tokens.input;
  sums.output += event.tokens.output;
  sums.reasoning += event.tokens.reasoning;
  sums.cacheRead += event.tokens.cache.read;
  sums.cacheWrite += event.tokens.cache.write;
  sums.cost += event.cost;
}

function max0(value: number): number {
  return value > 0 ? value : 0;
}

/**
 * Reconciles a completely fetched session. Assistant-message sums are compared
 * component-wise with the session snapshot totals:
 * - sums at or below totals → complete, plus one residual event carrying the
 *   nonnegative differences at `session.time.updated`;
 * - any sum above its session component, or message timestamps after the
 *   session's last update → mismatch, keeping only the provisional snapshot
 *   allocation. Negative residuals and mixed incompatible totals never occur.
 *
 * The raw assistant records are normalized and discarded incrementally; only
 * component sums and numeric events are retained. The returned event set
 * replaces the session's complete allocation.
 */
export async function reconcileSession(
  session: SessionRecord,
  assistantInputs: Iterable<unknown> | AsyncIterable<unknown>,
): Promise<ReconciledSession> {
  const events: UsageEvent[] = [];
  const sums = emptySums();
  let lastMessageTimestamp = 0;

  for await (const raw of assistantInputs) {
    const event = normalizeAssistantEvent(session, raw);

    if (!event) {
      continue;
    }

    events.push(event);
    accumulate(sums, event);
    lastMessageTimestamp = Math.max(lastMessageTimestamp, event.timestamp);
  }

  // A session without recorded snapshot usage cannot be compared; complete
  // message sums are authoritative in that case.
  const comparable = session.tokens !== null || session.cost !== null;

  if (comparable) {
    const snapshotTokens = session.tokens ?? { ...EMPTY_TOKENS, cache: { ...EMPTY_TOKENS.cache } };
    const snapshotCost = session.cost ?? 0;

    const exceeds =
      sums.input > snapshotTokens.input + COST_TOLERANCE ||
      sums.output > snapshotTokens.output + COST_TOLERANCE ||
      sums.reasoning > snapshotTokens.reasoning + COST_TOLERANCE ||
      sums.cacheRead > snapshotTokens.cache.read + COST_TOLERANCE ||
      sums.cacheWrite > snapshotTokens.cache.write + COST_TOLERANCE ||
      sums.cost > snapshotCost + COST_TOLERANCE;

    const inconsistent = lastMessageTimestamp > session.timeUpdated + COST_TOLERANCE;

    if (exceeds || inconsistent) {
      const fallback = snapshotEvent(session);
      return {
        state: 'mismatch',
        events: fallback ? [fallback] : [],
        hasResidual: false,
      };
    }
  }

  // Residual allocation: what the snapshot records beyond the message sums.
  const residualTokens: TokenUsage = {
    input: max0((session.tokens?.input ?? 0) - sums.input),
    output: max0((session.tokens?.output ?? 0) - sums.output),
    reasoning: max0((session.tokens?.reasoning ?? 0) - sums.reasoning),
    cache: {
      read: max0((session.tokens?.cache.read ?? 0) - sums.cacheRead),
      write: max0((session.tokens?.cache.write ?? 0) - sums.cacheWrite),
    },
  };
  const residualCost = max0((session.cost ?? 0) - sums.cost);
  const residualTotal = totalTokens(residualTokens);

  if (comparable && (residualTotal > COST_TOLERANCE || residualCost > COST_TOLERANCE)) {
    events.push({
      sessionId: session.sessionId,
      timestamp: session.timeUpdated,
      // No unambiguous model attribution for reconciled differences.
      tokens: residualTokens,
      cost: residualCost,
      messageCount: 0,
      source: 'residual',
      estimated: true,
    });

    return {
      state: 'complete',
      events,
      hasResidual: true,
    };
  }

  return {
    state: 'complete',
    events,
    hasResidual: false,
  };
}
