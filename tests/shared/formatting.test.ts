import { describe, expect, it } from 'vitest';

import {
  formatCompactNumber,
  formatDayLabel,
  formatDayShort,
  formatFullNumber,
  formatSessionSpan,
  formatUsd,
} from '../../src/shared/formatting';

describe('formatDayLabel', () => {
  it('formats a day key as a localized date parsed in local time', () => {
    expect(formatDayLabel('2026-11-10', 'en-GB')).toBe('10 Nov 2026');
    expect(formatDayLabel('2026-01-05', 'en-US')).toBe('Jan 5, 2026');
  });

  it('returns the input unchanged when it is not a day key', () => {
    expect(formatDayLabel('Mon')).toBe('Mon');
    expect(formatDayLabel('')).toBe('');
  });
});

describe('formatDayShort', () => {
  it('formats a compact day and month label', () => {
    expect(formatDayShort('2026-11-10', 'en-GB')).toBe('10 Nov');
  });

  it('returns the input unchanged when it is not a day key', () => {
    expect(formatDayShort('soon')).toBe('soon');
  });
});

describe('formatCompactNumber', () => {
  it('formats compact locale output', () => {
    expect(formatCompactNumber(0)).toBe('0');
    expect(formatCompactNumber(999)).toBe('999');
    expect(formatCompactNumber(1000)).toBe('1K');
    expect(formatCompactNumber(1234567)).toBe('1.2M');
  });

  it('uses at most one fraction digit', () => {
    expect(formatCompactNumber(1500)).toBe('1.5K');
    expect(formatCompactNumber(1_234_567_890)).toBe('1.2B');
  });

  it('renders a placeholder for non-finite input', () => {
    expect(formatCompactNumber(Number.NaN)).toBe('—');
    expect(formatCompactNumber(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('formatFullNumber', () => {
  it('keeps full grouping for accessible labels', () => {
    expect(formatFullNumber(1234567)).toBe('1,234,567');
    expect(formatFullNumber(0)).toBe('0');
  });
});

describe('formatUsd', () => {
  it('formats standard amounts with two fraction digits', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(1234.5)).toBe('$1,234.50');
    expect(formatUsd(0.25)).toBe('$0.25');
  });

  it('never shows a misleading $0.00 for tiny nonzero costs', () => {
    expect(formatUsd(0.001)).toBe('<$0.01');
    expect(formatUsd(0.0001)).toBe('<$0.01');
    expect(formatUsd(0.009)).toBe('<$0.01');
  });

  it('keeps cent amounts exact', () => {
    expect(formatUsd(0.01)).toBe('$0.01');
    expect(formatUsd(0.05)).toBe('$0.05');
  });
});

describe('formatSessionSpan', () => {
  it('formats wall-clock spans as minutes, hours, then days', () => {
    expect(formatSessionSpan(0)).toBe('0m');
    expect(formatSessionSpan(10_000)).toBe('0m');
    expect(formatSessionSpan(30_000)).toBe('1m');
    expect(formatSessionSpan(90_000)).toBe('2m');
    expect(formatSessionSpan(45 * 60_000)).toBe('45m');
    expect(formatSessionSpan(90 * 60_000)).toBe('2h');
    expect(formatSessionSpan(20 * 3_600_000)).toBe('20h');
    expect(formatSessionSpan(30 * 3_600_000)).toBe('1d');
    expect(formatSessionSpan(50 * 3_600_000)).toBe('2d');
  });

  it('treats invalid spans as zero', () => {
    expect(formatSessionSpan(-5_000)).toBe('0m');
    expect(formatSessionSpan(Number.NaN)).toBe('0m');
    expect(formatSessionSpan(Number.POSITIVE_INFINITY)).toBe('0m');
  });
});
