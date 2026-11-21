import { describe, expect, it } from 'vitest';

import { normalizeSession } from '../../src/service/normalize';
import { reconcileSession } from '../../src/service/reconcile-session';
import { totalTokens } from '../../src/shared/analytics-types';
import type { UsageEvent } from '../../src/shared/analytics-types';

const SESSION_RAW = {
  id: 'ses_r',
  title: 'Reconcile me',
  directory: '/repo/demo',
  cost: 1.0,
  tokens: { input: 100, output: 40, reasoning: 6, cache: { read: 30, write: 4 } },
  time: { created: 1_700_000_000_000, updated: 1_700_000_500_000 },
};

const SESSION = normalizeSession(SESSION_RAW)!;

function assistantMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'msg_a',
    type: 'assistant',
    model: { id: 'glm-5', providerID: 'zai' },
    cost: 0.4,
    tokens: { input: 40, output: 20, reasoning: 2, cache: { read: 10, write: 1 } },
    time: { created: 1_700_000_100_000 },
    ...overrides,
  };
}

function eventTotal(event: UsageEvent): number {
  return totalTokens(event.tokens);
}

describe('reconcileSession', () => {
  it('completes without residual when message sums equal session totals', async () => {
    const messages = [
      assistantMessage(),
      assistantMessage({
        id: 'msg_b',
        cost: 0.6,
        tokens: { input: 60, output: 20, reasoning: 4, cache: { read: 20, write: 3 } },
        time: { created: 1_700_000_200_000 },
      }),
    ];

    const result = await reconcileSession(SESSION, messages);

    expect(result.state).toBe('complete');
    expect(result.hasResidual).toBe(false);
    expect(result.events).toHaveLength(2);
    const sum = result.events.reduce((acc, event) => acc + eventTotal(event), 0);
    const snapshotTotal = totalTokens(SESSION.tokens!);
    expect(sum).toBe(snapshotTotal);
    expect(result.events.reduce((acc, event) => acc + event.cost, 0)).toBeCloseTo(1.0, 9);
  });

  it('allocates one estimated residual event at the session update when sums fall below totals', async () => {
    const result = await reconcileSession(SESSION, [assistantMessage()]);
    const residual = result.events.find((event) => event.source === 'residual');

    expect(result.state).toBe('complete');
    expect(result.hasResidual).toBe(true);
    expect(residual).toBeDefined();
    expect(residual?.timestamp).toBe(1_700_000_500_000);
    expect(residual?.estimated).toBe(true);
    expect(residual?.tokens).toEqual({
      input: 60,
      output: 20,
      reasoning: 4,
      cache: { read: 20, write: 3 },
    });
    expect(residual?.cost).toBeCloseTo(0.6, 9);
    expect(residual?.messageCount).toBe(0);
  });

  it('never emits negative residual components', async () => {
    const result = await reconcileSession(SESSION, [
      assistantMessage({ tokens: { input: 200, output: 10, reasoning: 0, cache: { read: 0, write: 4 } } }),
    ]);
    const residual = result.events.find((event) => event.source === 'residual');

    // input alone exceeds the session total, so the session is a mismatch instead.
    expect(result.state).toBe('mismatch');
    expect(residual).toBeUndefined();
  });

  it('completes an empty successful history with positive totals through residual allocation', async () => {
    const result = await reconcileSession(SESSION, []);

    expect(result.state).toBe('complete');
    expect(result.hasResidual).toBe(true);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.source).toBe('residual');
    expect(eventTotal(result.events[0]!)).toBe(totalTokens(SESSION.tokens!));
  });

  it('completes a zero-usage session without fabricating usage', async () => {
    const zeroSession = normalizeSession({
      ...SESSION_RAW,
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })!;

    const result = await reconcileSession(zeroSession, []);

    expect(result.state).toBe('complete');
    expect(result.hasResidual).toBe(false);
    expect(result.events).toEqual([]);
  });

  it('falls back to snapshot-only events on mismatch when a message sum exceeds the session component', async () => {
    const result = await reconcileSession(SESSION, [
      assistantMessage({ cost: 1.2 }),
    ]);

    expect(result.state).toBe('mismatch');
    expect(result.hasResidual).toBe(false);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.source).toBe('session-snapshot');
    expect(result.events[0]?.estimated).toBe(true);
  });

  it('treats message timestamps after the session update as inconsistent', async () => {
    const result = await reconcileSession(SESSION, [
      assistantMessage({ time: { created: 1_700_000_600_000 } }),
    ]);

    expect(result.state).toBe('mismatch');
    expect(result.events.map((event) => event.source)).toEqual(['session-snapshot']);
  });

  it('keeps each message model identity on its own event', async () => {
    const result = await reconcileSession(SESSION, [
      assistantMessage(),
      assistantMessage({ id: 'msg_c', model: { id: 'glm-6', providerID: 'zai' } }),
    ]);

    const models = result.events.filter((event) => event.source === 'assistant').map((event) => event.modelID);
    expect(models).toEqual(['glm-5', 'glm-6']);
  });

  it('allocates message-time events at their own timestamps, not the session update day', async () => {
    const result = await reconcileSession(SESSION, [assistantMessage()]);
    const assistant = result.events.find((event) => event.source === 'assistant');

    expect(assistant?.timestamp).toBe(1_700_000_100_000);
    expect(assistant?.timestamp).not.toBe(1_700_000_500_000);
  });

  it('consumes async iterables incrementally', async () => {
    async function* history(): AsyncGenerator<Record<string, unknown>> {
      yield assistantMessage();
      yield assistantMessage({
        id: 'msg_b',
        cost: 0.6,
        tokens: { input: 60, output: 20, reasoning: 4, cache: { read: 20, write: 3 } },
        time: { created: 1_700_000_200_000 },
      });
    }

    const result = await reconcileSession(SESSION, history());

    expect(result.state).toBe('complete');
    expect(result.hasResidual).toBe(false);
    expect(result.events).toHaveLength(2);
  });

  it('compares against an unknown snapshot by trusting complete message sums', async () => {
    const unknownUsage = normalizeSession({ ...SESSION_RAW, cost: undefined, tokens: undefined })!;
    const result = await reconcileSession(unknownUsage, [assistantMessage()]);

    expect(result.state).toBe('complete');
    expect(result.hasResidual).toBe(false);
    expect(result.events).toHaveLength(1);
  });

  it('drops malformed messages and recovers their usage through residual', async () => {
    const result = await reconcileSession(SESSION, [
      assistantMessage(),
      { type: 'user' },
      'garbage',
      { type: 'assistant' },
    ]);

    expect(result.state).toBe('complete');
    expect(result.hasResidual).toBe(true);
    const assistants = result.events.filter((event) => event.source === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(eventTotal(result.events.find((event) => event.source === 'residual')!)).toBe(
      totalTokens(SESSION.tokens!) - eventTotal(assistants[0]!),
    );
  });
});
