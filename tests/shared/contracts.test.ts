import { describe, expect, it } from 'vitest';

import { EMPTY_TOKENS, totalTokens } from '../../src/shared/analytics-types';

describe('token contract', () => {
  it('exposes a zero token object with all five numeric components', () => {
    expect(EMPTY_TOKENS.input).toBe(0);
    expect(EMPTY_TOKENS.output).toBe(0);
    expect(EMPTY_TOKENS.reasoning).toBe(0);
    expect(EMPTY_TOKENS.cache.read).toBe(0);
    expect(EMPTY_TOKENS.cache.write).toBe(0);
  });

  it('sums all five components into totalTokens', () => {
    expect(
      totalTokens({ input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 1 } }),
    ).toBe(21);
  });

  it('treats missing components as zero', () => {
    expect(
      totalTokens({ input: 4, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }),
    ).toBe(5);
  });
});
