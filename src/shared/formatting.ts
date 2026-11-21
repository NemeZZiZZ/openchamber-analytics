const PLACEHOLDER = '—';

const formatterCache = new Map<string, Intl.DateTimeFormat | Intl.NumberFormat>();

function cached<T extends Intl.DateTimeFormat | Intl.NumberFormat>(kind: string, locale: string | undefined, create: () => T): T {
  const key = `${kind}|${locale ?? ''}`;
  let formatter = formatterCache.get(key) as T | undefined;

  if (!formatter) {
    formatter = create();
    formatterCache.set(key, formatter);
  }

  return formatter;
}

const DAY_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function dayLabelFormatter(locale?: string): Intl.DateTimeFormat {
  return cached('dayLabelFormatter', locale, () => new Intl.DateTimeFormat(locale ?? undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }));
}

function dayShortFormatter(locale?: string): Intl.DateTimeFormat {
  return cached('dayShortFormatter', locale, () => new Intl.DateTimeFormat(locale ?? undefined, {
    day: 'numeric',
    month: 'short',
  }));
}

/** Formats a day key with the given date-time formatter; non-day keys pass through. */
function formatDayKey(day: string, formatter: Intl.DateTimeFormat): string {
  const match = DAY_KEY_PATTERN.exec(day);

  if (!match) {
    return day;
  }

  // Parse as a LOCAL calendar date: `new Date('2026-11-10')` is UTC and would
  // shift the calendar day in negative-offset timezones.
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));

  return Number.isNaN(date.getTime()) ? day : formatter.format(date);
}

/** Localized calendar date for a local day key ("2026-11-10" → "10 Nov 2026" in en-GB). */
export function formatDayLabel(day: string, locale?: string): string {
  return formatDayKey(day, dayLabelFormatter(locale));
}

/** Compact day + month for ranges ("2026-11-10" → "10 Nov" in en-GB). */
export function formatDayShort(day: string, locale?: string): string {
  return formatDayKey(day, dayShortFormatter(locale));
}

function compactFormatter(locale?: string): Intl.NumberFormat {
  return cached('compactFormatter', locale, () => new Intl.NumberFormat(locale, {
    notation: 'compact',
    maximumFractionDigits: 1,
  }));
}

function fullFormatter(locale?: string): Intl.NumberFormat {
  return cached('fullFormatter', locale, () => new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
  }));
}

function currencyFormatter(locale?: string): Intl.NumberFormat {
  return cached('currencyFormatter', locale, () => new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  }));
}

/** Locale-aware compact number with at most one fraction digit. */
export function formatCompactNumber(value: number, locale?: string): string {
  if (!Number.isFinite(value)) {
    return PLACEHOLDER;
  }

  return compactFormatter(locale).format(value);
}

/** Locale-aware grouped number for accessible labels and tooltips. */
export function formatFullNumber(value: number, locale?: string): string {
  if (!Number.isFinite(value)) {
    return PLACEHOLDER;
  }

  return fullFormatter(locale).format(value);
}

/**
 * Locale-aware USD amount. Very small nonzero costs render as <$0.01 instead
 * of a misleading $0.00; exact zero stays $0.00.
 */
/** Locale-aware percentage of a 0..1 fraction, e.g. 0.09 → "9%". */
export function formatPercent(fraction: number, locale?: string): string {
  if (!Number.isFinite(fraction)) {
    return PLACEHOLDER;
  }

  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(fraction);
}

/**
 * USD with up to four fraction digits, for per-million and per-session rates
 * whose honest magnitude sits below one cent.
 */
export function formatUsdExact(value: number, locale?: string): string {
  if (!Number.isFinite(value)) {
    return PLACEHOLDER;
  }

  if (value > 0 && value < 0.0001) {
    return '<$0.0001';
  }

  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 4,
  }).format(value);
}

export function formatUsd(value: number, locale?: string): string {
  if (!Number.isFinite(value)) {
    return PLACEHOLDER;
  }

  if (value > 0 && value < 0.01) {
    return '<$0.01';
  }

  return currencyFormatter(locale).format(value);
}

/** Response latency: `450ms`, `3.2s`, `1.5m`; unavailable values read `—`. */
export function formatLatency(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) {
    return '—';
  }

  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }

  const seconds = ms / 1000;

  return seconds < 60 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds / 6) / 10}m`;
}

/**
 * Wall-clock session span (updated - created) as rounded minutes, then hours,
 * then days: `0m`, `45m`, `20h`, `2d`. Invalid or negative spans format as 0m.
 */
export function formatSessionSpan(spanMs: number): string {
  if (!Number.isFinite(spanMs) || spanMs <= 0) {
    return '0m';
  }

  const minutes = Math.round(spanMs / 60_000);

  if (minutes < 60) {
    return `${minutes}m`;
  }

  if (minutes < 60 * 24) {
    return `${Math.round(minutes / 60)}h`;
  }

  return `${Math.round(minutes / (60 * 24))}d`;
}
