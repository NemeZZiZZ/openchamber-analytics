import { describe, expect, it } from 'vitest';

import { normalizeAssistantEvent, normalizeSession, sessionFingerprint, snapshotEvent } from '../../src/service/normalize';
import type { SessionRecord } from '../../src/shared/analytics-types';

function rawSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ses_test',
    title: 'Fix login bug',
    agent: 'build',
    model: { id: 'glm-5', providerID: 'zai' },
    cost: 0.5,
    tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 20, write: 5 } },
    location: { directory: '/repo/openchamber-analytics' },
    time: { created: 1_700_000_000_000, updated: 1_700_000_100_000 },
    ...overrides,
  };
}

describe('normalizeSession', () => {
  it('normalizes a complete session snapshot', () => {
    const record = normalizeSession(rawSession());

    expect(record).not.toBeNull();
    const session = record as SessionRecord;
    expect(session.sessionId).toBe('ses_test');
    expect(session.title).toBe('Fix login bug');
    expect(session.directory).toBe('/repo/openchamber-analytics');
    expect(session.agent).toBe('build');
    expect(session.modelID).toBe('glm-5');
    expect(session.providerID).toBe('zai');
    expect(session.timeCreated).toBe(1_700_000_000_000);
    expect(session.timeUpdated).toBe(1_700_000_100_000);
    expect(session.cost).toBe(0.5);
    expect(session.tokens).toEqual({
      input: 100,
      output: 50,
      reasoning: 10,
      cache: { read: 20, write: 5 },
    });
  });

  it('reads flat directory fallbacks and falls back to an untitled session', () => {
    const record = normalizeSession(rawSession({ title: '', location: undefined, directory: '/repo/x' }));
    expect(record?.directory).toBe('/repo/x');
    expect(record?.title).toBe('Untitled session');
  });

  it('extracts the terminal outcome, dropping unknown values', () => {
    const done = normalizeSession(rawSession({ outcome: 'succeeded', time: { created: 1_700_000_000_000, updated: 1_700_000_100_000, busy: 250_000, idle: 30_000 } }));
    expect(done?.outcome).toBe('succeeded');
    // time.busy/idle are transition timestamps upstream, not durations —
    // they must not be stored as metrics.
    expect('busyMs' in (done ?? {})).toBe(false);
    expect('idleMs' in (done ?? {})).toBe(false);

    const interrupted = normalizeSession(rawSession({ outcome: 'interrupted' }));
    expect(interrupted?.outcome).toBe('interrupted');

    const bogus = normalizeSession(rawSession({ outcome: 'exploded', time: { created: 1_700_000_000_000, updated: 1_700_000_100_000, busy: -5, idle: Number.NaN } }));
    expect(bogus?.outcome).toBeUndefined();
  });

  it('treats absent cost/tokens/model as unknown data, not zeros', () => {
    const record = normalizeSession(rawSession({ cost: undefined, tokens: undefined, model: undefined }));

    expect(record?.tokens).toBeNull();
    expect(record?.cost).toBeNull();
    expect(record?.modelID).toBeUndefined();
    expect(record?.providerID).toBeUndefined();
  });

  it('keeps valid zero usage as real data', () => {
    const record = normalizeSession(
      rawSession({
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    );

    expect(record?.cost).toBe(0);
    expect(record?.tokens).toEqual({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });
  });

  it('clamps malformed numbers at the trust boundary', () => {
    const record = normalizeSession(
      rawSession({
        cost: -1,
        tokens: { input: -5, output: Number.NaN, reasoning: Number.POSITIVE_INFINITY, cache: { read: '9', write: 3 } },
      }),
    );

    expect(record?.cost).toBe(0);
    expect(record?.tokens).toEqual({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 3 } });
  });

  it('drops a garbage model identity instead of fabricating one', () => {
    const record = normalizeSession(rawSession({ model: { id: 42, providerID: null } }));

    expect(record?.modelID).toBeUndefined();
    expect(record?.providerID).toBeUndefined();
  });

  it('captures the model variant tier from session and assistant messages', () => {
    const raw = {
      id: 'ses_var',
      time: { created: 1000, updated: 2000 },
      model: { providerID: 'zai', id: 'glm-5', variant: 'max' },
      tokens: { input: 5 },
      cost: 0.1,
    };
    const session = normalizeSession(raw)!;
    expect(session.variant).toBe('max');

    const event = normalizeAssistantEvent(session, {
      type: 'assistant',
      time: { created: 2500 },
      model: { providerID: 'zai', id: 'glm-5', variant: 'high' },
      tokens: { input: 1 },
      cost: 0,
    })!;
    expect(event.variant).toBe('high');
    expect(event.messageCount).toBe(1);

    const snapshot = snapshotEvent(session)!;
    expect(snapshot.variant).toBe('max');
    expect(snapshot.messageCount).toBe(0);
  });

  it('keeps the parent session link when present', () => {
    const record = normalizeSession(rawSession({ parentID: 'ses_parent' }));
    expect(record?.parentSessionId).toBe('ses_parent');
  });

  it('returns null for malformed session identity', () => {
    expect(normalizeSession(null)).toBeNull();
    expect(normalizeSession('nope')).toBeNull();
    expect(normalizeSession({ title: 'no id' })).toBeNull();
    expect(normalizeSession(rawSession({ id: '' }))).toBeNull();
    expect(normalizeSession(rawSession({ id: 123 }))).toBeNull();
    expect(normalizeSession(rawSession({ time: {} }))).toBeNull();
    expect(normalizeSession(rawSession({ time: { created: 'yesterday' } }))).toBeNull();
  });
});

describe('sessionFingerprint', () => {
  const base = normalizeSession(rawSession()) as SessionRecord;

  it('is stable for identical snapshots', () => {
    const again = normalizeSession(rawSession()) as SessionRecord;
    expect(sessionFingerprint(base)).toBe(sessionFingerprint(again));
  });

  it('changes when time.updated, usage, or model changes', () => {
    const updated = normalizeSession(rawSession({ time: { created: 1_700_000_000_000, updated: 1_700_000_200_000 } })) as SessionRecord;
    const cost = normalizeSession(rawSession({ cost: 0.6 })) as SessionRecord;
    const tokens = normalizeSession(rawSession({ tokens: { input: 101, output: 50, reasoning: 10, cache: { read: 20, write: 5 } } })) as SessionRecord;
    const model = normalizeSession(rawSession({ model: { id: 'glm-6', providerID: 'zai' } })) as SessionRecord;

    expect(sessionFingerprint(updated)).not.toBe(sessionFingerprint(base));
    expect(sessionFingerprint(cost)).not.toBe(sessionFingerprint(base));
    expect(sessionFingerprint(tokens)).not.toBe(sessionFingerprint(base));
    expect(sessionFingerprint(model)).not.toBe(sessionFingerprint(base));
  });

  it('ignores analytics-irrelevant metadata like titles', () => {
    const retitled = normalizeSession(rawSession({ title: 'Different title' })) as SessionRecord;
    expect(sessionFingerprint(retitled)).toBe(sessionFingerprint(base));
  });
});

describe('normalizeAssistantEvent', () => {
  const session = normalizeSession(rawSession()) as SessionRecord;

  it('normalizes an assistant message with model and message-time allocation', () => {
    const raw = {
      id: 'msg_1',
      type: 'assistant',
      agent: 'build',
      model: { id: 'glm-5', providerID: 'zai' },
      cost: 0.25,
      tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 1 } },
      time: { created: 1_700_000_050_000 },
    };

    const event = normalizeAssistantEvent(session, raw);

    expect(event).not.toBeNull();
    expect(event?.sessionId).toBe('ses_test');
    expect(event?.timestamp).toBe(1_700_000_050_000);
    expect(event?.source).toBe('assistant');
    expect(event?.estimated).toBe(false);
    expect(event?.messageCount).toBe(1);
    expect(event?.tokens).toEqual({ input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 1 } });
    expect(event?.cost).toBe(0.25);
    expect(event?.modelID).toBe('glm-5');
    expect(event?.providerID).toBe('zai');
    expect(event?.agent).toBe('build');
  });

  it('defaults missing usage to zeros and drops unknown message types', () => {
    const sparse = normalizeAssistantEvent(session, { id: 'msg_2', type: 'assistant', time: { created: 1 } });
    expect(sparse?.tokens).toEqual({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });
    expect(sparse?.cost).toBe(0);
    expect(sparse?.providerID).toBeUndefined();

    expect(normalizeAssistantEvent(session, { id: 'msg_3', type: 'user', time: { created: 1 } })).toBeNull();
    expect(normalizeAssistantEvent(session, 'garbage')).toBeNull();
    expect(normalizeAssistantEvent(session, { id: 'msg_4', type: 'assistant' })).toBeNull();
  });

  it('extracts timing, finish, retry and tool facts without keeping content', () => {
    const event = normalizeAssistantEvent(session, {
      id: 'msg_q',
      type: 'assistant',
      time: { created: 1000, firstToken: 1400, completed: 3400 },
      finish: 'length',
      retry: { attempt: 2, at: 1100, error: {} },
      content: [
        { type: 'text', text: 'secret prompt answer' },
        { type: 'tool', name: 'bash', state: { status: 'completed' } },
        { type: 'tool', name: 'edit', state: { status: 'error' } },
      ],
    });

    expect(event).toMatchObject({
      durationMs: 2400,
      firstTokenMs: 400,
      finish: 'length',
      hasError: false,
      retries: 2,
      toolCalls: 2,
      toolErrors: 1,
    });
    expect(JSON.stringify(event)).not.toContain('secret');
  });

  it('omits quality facts that are absent or inconsistent', () => {
    const event = normalizeAssistantEvent(session, {
      id: 'msg_r',
      type: 'assistant',
      time: { created: 5000, firstToken: 4000, completed: 4500 },
      finish: 'banana',
      error: { name: 'x' },
    });

    expect(event?.durationMs).toBeUndefined();
    expect(event?.firstTokenMs).toBeUndefined();
    expect(event?.finish).toBeUndefined();
    expect(event?.hasError).toBe(true);
    expect(event?.toolCalls).toBeUndefined();
  });

  it('clamps negative and non-finite usage to zero', () => {
    const bad = normalizeAssistantEvent(session, {
      id: 'msg_5',
      type: 'assistant',
      cost: -2,
      tokens: { input: -1, output: Number.NaN, reasoning: Number.POSITIVE_INFINITY, cache: { read: -9, write: 4 } },
      time: { created: 1 },
    });

    expect(bad?.cost).toBe(0);
    expect(bad?.tokens).toEqual({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 4 } });
  });
});

describe('snapshotEvent', () => {
  it('produces one provisional event at session.time.updated', () => {
    const session = normalizeSession(rawSession()) as SessionRecord;
    const event = snapshotEvent(session);

    expect(event).not.toBeNull();
    expect(event?.timestamp).toBe(1_700_000_100_000);
    expect(event?.source).toBe('session-snapshot');
    expect(event?.estimated).toBe(true);
    expect(event?.messageCount).toBe(0);
    expect(event?.sessionId).toBe('ses_test');
    expect(event?.modelID).toBe('glm-5');
    expect(totalEventTokens(event?.tokens)).toBe(185);
    expect(event?.cost).toBe(0.5);
  });

  it('returns null only for a genuinely zero-usage session', () => {
    const zero = normalizeSession(rawSession({ cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })) as SessionRecord;
    expect(snapshotEvent(zero)).toBeNull();

    const unknown = normalizeSession(rawSession({ cost: undefined, tokens: undefined })) as SessionRecord;
    expect(snapshotEvent(unknown)).toBeNull();
  });

  it('keeps a positive cost even without token data', () => {
    const costOnly = normalizeSession(rawSession({ tokens: undefined })) as SessionRecord;
    const event = snapshotEvent(costOnly);

    expect(event?.cost).toBe(0.5);
    expect(event?.tokens).toEqual({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });
  });
});

function totalEventTokens(tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } } | undefined): number {
  if (!tokens) return 0;
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write;
}
