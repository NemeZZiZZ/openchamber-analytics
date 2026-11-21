import { describe, expect, it } from 'vitest';

import { aggregateModels, buildPrimaryModelSessionDonut, topModelsWithOther } from '../../src/service/aggregate-models';
import { rankTopProjects, rankTopSessions } from '../../src/service/aggregate-models';
import { createPeriodWindow } from '../../src/service/time';
import { totalTokens } from '../../src/shared/analytics-types';
import type { SessionRecord, UsageEvent } from '../../src/shared/analytics-types';

const TZ = 'UTC';
const NOW = Date.parse('2026-11-18T12:00:00Z');

function makeEvent(overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    sessionId: 'ses_1',
    timestamp: NOW - 3_600_000,
    providerID: 'zai',
    modelID: 'glm-5',
    tokens: { input: 60, output: 20, reasoning: 20, cache: { read: 0, write: 0 } },
    cost: 0.5,
    messageCount: 1,
    source: 'assistant',
    estimated: false,
    ...overrides,
  };
}

const EVENTS: UsageEvent[] = [
  makeEvent(),
  makeEvent({ modelID: 'glm-6', tokens: { input: 30, output: 10, reasoning: 10, cache: { read: 0, write: 0 } }, cost: 0.4 }),
  makeEvent({ sessionId: 'ses_2', tokens: { input: 18, output: 6, reasoning: 6, cache: { read: 0, write: 0 } }, cost: 0.1 }),
  makeEvent({ sessionId: 'ses_2', providerID: undefined, modelID: undefined, tokens: { input: 6, output: 2, reasoning: 2, cache: { read: 0, write: 0 } }, cost: 0.05 }),
  makeEvent({ sessionId: 'ses_3', providerID: 'openai', modelID: 'gpt-5', tokens: { input: 120, output: 40, reasoning: 40, cache: { read: 0, write: 0 } }, cost: 2.0 }),
];

describe('aggregateModels', () => {
  it('sums tokens, cost, reasoning, and overlapping sessions per model', () => {
    const models = aggregateModels(EVENTS, 'tokens');
    const glm5 = models.find((model) => model.modelKey === 'zai/glm-5');
    const glm6 = models.find((model) => model.modelKey === 'zai/glm-6');
    const unknown = models.find((model) => model.modelKey === 'unknown/unknown');

    expect(glm5?.tokens).toBe(130);
    expect(glm5?.cost).toBeCloseTo(0.6, 9);
    expect(glm5?.reasoningTokens).toBe(26);
    expect(glm5?.sessions).toBe(2);
    expect(glm6?.sessions).toBe(1);
    // ses_1 appears under both glm-5 and glm-6: per-model counts overlap.
    expect(models.reduce((acc, model) => acc + model.sessions, 0)).toBe(5);
    expect(unknown).toBeDefined();
  });

  it('computes token share over all attributed model tokens', () => {
    const models = aggregateModels(EVENTS, 'tokens');
    const gpt5 = models.find((model) => model.modelKey === 'openai/gpt-5');
    expect(gpt5?.tokens).toBe(200);
    expect(gpt5?.share).toBeCloseTo(200 / 390, 9);
  });

  it('ranks by the selected metric and reorders without losing identity', () => {
    const byTokens = aggregateModels(EVENTS, 'tokens').map((model) => model.modelKey);
    const byCost = aggregateModels(EVENTS, 'cost').map((model) => model.modelKey);
    const bySessions = aggregateModels(EVENTS, 'sessions').map((model) => model.modelKey);

    expect(byTokens).toEqual(['openai/gpt-5', 'zai/glm-5', 'zai/glm-6', 'unknown/unknown']);
    expect(byCost).toEqual(['openai/gpt-5', 'zai/glm-5', 'zai/glm-6', 'unknown/unknown']);
    expect(bySessions[0]).toBe('zai/glm-5');
    // Source identity travels with each aggregate regardless of order.
    for (const models of [aggregateModels(EVENTS, 'tokens'), aggregateModels(EVENTS, 'cost')]) {
      for (const model of models) {
        expect(model.tokens).toBeGreaterThan(0);
        expect(model.modelKey).toContain('/');
      }
    }
  });

  it('breaks ties by stable model key', () => {
    const tied: UsageEvent[] = [
      makeEvent({ providerID: 'b-provider', modelID: 'alpha' }),
      makeEvent({ sessionId: 'ses_2', providerID: 'a-provider', modelID: 'beta' }),
    ];

    const models = aggregateModels(tied, 'tokens');
    expect(models.map((model) => model.modelKey)).toEqual(['a-provider/beta', 'b-provider/alpha']);
  });
});

describe('variant rows', () => {
  it('ranks the same model with different variants as separate rows with own steps', () => {
    const events = [
      makeEvent({ messageCount: 3, variant: 'max' }),
      makeEvent({ messageCount: 2, variant: 'high' }),
      makeEvent({ messageCount: 1 }),
    ];

    const models = aggregateModels(events, 'tokens');

    expect(models).toHaveLength(3);
    expect(models.map((model) => `${model.modelKey}:${model.steps}`)).toEqual(
      expect.arrayContaining(['zai/glm-5@max:3', 'zai/glm-5@high:2', 'zai/glm-5:1']),
    );
    const maxRow = models.find((model) => model.variant === 'max')!;
    expect(maxRow.modelKey).toBe('zai/glm-5@max');
  });
});

describe('topModelsWithOther', () => {
  const many: UsageEvent[] = Array.from({ length: 7 }, (_, index) =>
    makeEvent({
      sessionId: `ses_${index}`,
      modelID: `model-${index}`,
      tokens: { input: 10 * (7 - index), output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0.01 * (7 - index),
    }),
  );

  it('keeps the top five and collapses the rest into Other', () => {
    const result = topModelsWithOther(aggregateModels(many, 'tokens'), 'tokens', 5);

    expect(result).toHaveLength(6);
    const named = result.slice(0, 5).map((model) => model.modelKey);
    expect(named).toEqual([
      'zai/model-0',
      'zai/model-1',
      'zai/model-2',
      'zai/model-3',
      'zai/model-4',
    ]);

    const other = result[5];
    expect(other?.modelKey).toBe('__other__');
    // model-5 (20) + model-6 (10) with input-only tokens.
    expect(other?.tokens).toBe(30);
    expect(other?.cost).toBeCloseTo(0.03, 9);
  });

  it('counts distinct sessions in Other when model sessions overlap', () => {
    const shared: UsageEvent[] = [
      makeEvent({ sessionId: 'a', modelID: 'big', tokens: { input: 1000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
      makeEvent({ sessionId: 'x', modelID: 'small-1' }),
      makeEvent({ sessionId: 'x', modelID: 'small-2' }),
    ];
    const models = aggregateModels(shared, 'tokens');
    const result = topModelsWithOther(models, 'tokens', 1, shared);

    expect(result.at(-1)?.modelKey).toBe('__other__');
    expect(result.at(-1)?.sessions).toBe(1);
  });

  it('returns fewer rows without an Other bucket when models fit', () => {
    const result = topModelsWithOther(aggregateModels(EVENTS, 'tokens'), 'tokens', 5);
    expect(result).toHaveLength(4);
    expect(result.some((model) => model.modelKey === '__other__')).toBe(false);
  });
});

describe('buildPrimaryModelSessionDonut', () => {
  it('assigns each session to its greatest-token model so the donut sums to distinct sessions', () => {
    const donut = buildPrimaryModelSessionDonut(EVENTS, TZ);
    const sessionSum = donut.reduce((acc, model) => acc + model.sessions, 0);

    expect(sessionSum).toBe(3);
    expect(donut.find((model) => model.modelKey === 'zai/glm-5')?.sessions).toBe(2);
    expect(donut.find((model) => model.modelKey === 'openai/gpt-5')?.sessions).toBe(1);
    // glm-6 never dominates a session, so it has no primary slice.
    expect(donut.find((model) => model.modelKey === 'zai/glm-6')).toBeUndefined();
  });

  it('breaks primary-model ties by cost then stable model key', () => {
    const tied: UsageEvent[] = [
      makeEvent({ sessionId: 'ses_t', providerID: 'a', modelID: 'same', tokens: { input: 5, output: 5, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0.1 }),
      makeEvent({ sessionId: 'ses_t', providerID: 'b', modelID: 'same', tokens: { input: 5, output: 5, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0.3 }),
      makeEvent({ sessionId: 'ses_u', providerID: 'x', modelID: 'm1', tokens: { input: 4, output: 4, reasoning: 0, cache: { read: 0, write: 0 } } }),
      makeEvent({ sessionId: 'ses_u', providerID: 'y', modelID: 'm2', tokens: { input: 4, output: 4, reasoning: 0, cache: { read: 0, write: 0 } } }),
    ];

    const donut = buildPrimaryModelSessionDonut(tied, TZ);
    expect(donut.find((model) => model.modelKey === 'b/same')?.sessions).toBe(1);
    expect(donut.find((model) => model.modelKey === 'a/same')).toBeUndefined();
    // Full tie resolves to the stable smaller key.
    expect(donut.find((model) => model.modelKey === 'x/m1')?.sessions).toBe(1);
    expect(donut.find((model) => model.modelKey === 'y/m2')).toBeUndefined();
  });

  it('retains unknown models in the donut', () => {
    const only: UsageEvent[] = [makeEvent({ providerID: undefined, modelID: undefined })];
    const donut = buildPrimaryModelSessionDonut(only, TZ);
    expect(donut[0]?.modelKey).toBe('unknown/unknown');
  });
});

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: 'ses_top',
    title: 'Top session',
    directory: '/repo/demo',
    timeCreated: NOW - 86_400_000,
    timeUpdated: NOW,
    tokens: null,
    cost: null,
    ...overrides,
  };
}

describe('rankTopSessions', () => {
  const window = createPeriodWindow('30d', NOW, TZ);

  it('ranks by cost then tokens and caps at ten', () => {
    const events: UsageEvent[] = [];
    const sessions: SessionRecord[] = [];

    for (let index = 0; index < 12; index += 1) {
      const sessionId = `ses_${index}`;
      events.push(makeEvent({ sessionId, cost: 0.1 * (index + 1), tokens: { input: 10 * (12 - index), output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }));
      sessions.push(makeSession({ sessionId }));
    }

    const top = rankTopSessions(events, sessions, window, TZ);

    expect(top).toHaveLength(10);
    expect(top[0]?.sessionId).toBe('ses_11');
    expect(top[0]?.cost).toBeCloseTo(1.2, 9);
    expect(top[1]?.sessionId).toBe('ses_10');
  });

  it('breaks cost ties by tokens descending', () => {
    const events = [
      makeEvent({ sessionId: 'ses_low_tokens', cost: 1, tokens: { input: 5, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
      makeEvent({ sessionId: 'ses_high_tokens', cost: 1, tokens: { input: 50, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
    ];

    const top = rankTopSessions(events, [
      makeSession({ sessionId: 'ses_low_tokens' }),
      makeSession({ sessionId: 'ses_high_tokens' }),
    ], window, TZ);

    expect(top[0]?.sessionId).toBe('ses_high_tokens');
  });

  it('labels projects by the final non-empty directory segment', () => {
    const top = rankTopSessions([makeEvent()], [
      makeSession({ sessionId: 'ses_1', directory: '/repo/openchamber-analytics/' }),
    ], window, TZ);

    expect(top[0]?.projectLabel).toBe('openchamber-analytics');
    expect(top[0]?.title).toBe('Top session');
    expect(top[0]?.lastActivity).toBe(NOW - 3_600_000);
  });

  it('excludes sessions without events in the period', () => {
    const top = rankTopSessions([makeEvent()], [
      makeSession({ sessionId: 'ses_1' }),
      makeSession({ sessionId: 'ses_absent' }),
    ], window, TZ);

    expect(top).toHaveLength(1);
    expect(top[0]?.sessionId).toBe('ses_1');
    expect(top[0]?.tokens).toBe(totalTokens(makeEvent().tokens));
  });
});

describe('rankTopProjects', () => {
  const window = createPeriodWindow('30d', NOW, TZ);

  it('groups events by project, ranks by cost then tokens, and counts sessions', () => {
    const events: UsageEvent[] = [
      makeEvent({ sessionId: 'ses_a1', cost: 1, tokens: { input: 100, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
      makeEvent({ sessionId: 'ses_a2', cost: 0.5, tokens: { input: 50, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
      makeEvent({ sessionId: 'ses_b1', cost: 2, tokens: { input: 40, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
    ];
    const sessions: SessionRecord[] = [
      makeSession({ sessionId: 'ses_a1', directory: '/repo/alpha' }),
      makeSession({ sessionId: 'ses_a2', directory: '/repo/alpha' }),
      makeSession({ sessionId: 'ses_b1', directory: '/repo/beta' }),
    ];

    const top = rankTopProjects(events, sessions, window, TZ);

    expect(top).toHaveLength(2);
    expect(top[0]?.label).toBe('beta');
    expect(top[0]?.cost).toBeCloseTo(2, 9);
    expect(top[0]?.sessions).toBe(1);
    expect(top[1]?.label).toBe('alpha');
    expect(top[1]?.cost).toBeCloseTo(1.5, 9);
    expect(top[1]?.sessions).toBe(2);
    expect(top[1]?.tokens).toBe(150);
  });

  it('breaks cost ties by tokens descending', () => {
    const events: UsageEvent[] = [
      makeEvent({ sessionId: 'ses_low', cost: 1, tokens: { input: 10, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
      makeEvent({ sessionId: 'ses_high', cost: 1, tokens: { input: 90, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
    ];
    const sessions: SessionRecord[] = [
      makeSession({ sessionId: 'ses_low', directory: '/repo/low' }),
      makeSession({ sessionId: 'ses_high', directory: '/repo/high' }),
    ];

    const top = rankTopProjects(events, sessions, window, TZ);

    expect(top[0]?.label).toBe('high');
  });

  it('tracks last activity as the latest event timestamp in the project', () => {
    const events: UsageEvent[] = [
      makeEvent({ sessionId: 'ses_1', timestamp: NOW - 7_200_000 }),
      makeEvent({ sessionId: 'ses_2', timestamp: NOW - 1_800_000 }),
    ];
    const sessions: SessionRecord[] = [
      makeSession({ sessionId: 'ses_1', directory: '/repo/alpha' }),
      makeSession({ sessionId: 'ses_2', directory: '/repo/alpha' }),
    ];

    const top = rankTopProjects(events, sessions, window, TZ);

    expect(top).toHaveLength(1);
    expect(top[0]?.lastActivity).toBe(NOW - 1_800_000);
  });

  it('keeps different directories with the same basename separate', () => {
    const events = [makeEvent({ sessionId: 'ses_a' }), makeEvent({ sessionId: 'ses_b' })];
    const sessions = [
      makeSession({ sessionId: 'ses_a', directory: '/work/a/app' }),
      makeSession({ sessionId: 'ses_b', directory: '/work/b/app' }),
    ];

    const top = rankTopProjects(events, sessions, window, TZ);

    expect(top).toHaveLength(2);
    expect(top.map((project) => project.directory).sort()).toEqual(['/work/a/app', '/work/b/app']);
    expect(top.map((project) => project.label)).toEqual(['app', 'app']);
  });

  it('normalizes directory separators before grouping and returns a canonical directory', () => {
    const events = [makeEvent({ sessionId: 'ses_a' }), makeEvent({ sessionId: 'ses_b' })];
    const sessions = [
      makeSession({ sessionId: 'ses_a', directory: '/work/app/' }),
      makeSession({ sessionId: 'ses_b', directory: '/work/app' }),
    ];

    const top = rankTopProjects(events, sessions, window, TZ);

    expect(top).toHaveLength(1);
    expect(top[0]?.directory).toBe('/work/app');
    expect(top[0]?.sessions).toBe(2);
  });

  it('ignores events outside the period window', () => {
    const events: UsageEvent[] = [
      makeEvent({ sessionId: 'ses_in', timestamp: NOW - 3_600_000 }),
      makeEvent({ sessionId: 'ses_out', timestamp: NOW - 90 * 86_400_000, cost: 9, tokens: { input: 9999, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
    ];
    const sessions: SessionRecord[] = [
      makeSession({ sessionId: 'ses_in', directory: '/repo/alpha' }),
      makeSession({ sessionId: 'ses_out', directory: '/repo/beta' }),
    ];

    const top = rankTopProjects(events, sessions, window, TZ);

    expect(top.map((project) => project.label)).toEqual(['alpha']);
  });
});
