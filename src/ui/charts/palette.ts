/**
 * Chart palette derived from host `--oc-*` tokens with readable fallbacks.
 *
 * The host's internal `--chart-*` variables are NOT supplied to extension
 * iframes, so this palette resolves the public surface tokens instead and
 * never references `--chart-*`.
 */

export const FALLBACK_PALETTE: readonly string[] = Object.freeze([
  '#4c8dff', // primary
  '#39c0ed', // info
  '#34d399', // success
  '#a78bfa', // primary hue +120°
  '#f472b6', // primary hue +240°
  '#8b929c', // muted
]);

const PALETTE_TOKENS = ['--oc-primary', '--oc-info', '--oc-success'] as const;

const DERIVED_HUE_SHIFTS = [120, 240] as const;

export const SERIES_CLASSES = ['series-1', 'series-2', 'series-3', 'series-4', 'series-5', 'series-6'] as const;

export function seriesClass(index: number): string {
  return SERIES_CLASSES[index % SERIES_CLASSES.length] ?? SERIES_CLASSES[0]!;
}

function isValidColor(value: string): boolean {
  return value.trim() !== '' && value !== 'none' && !value.includes('undefined');
}

/**
 * Resolves the chart palette from host tokens. Series colours come from the
 * neutral brand/info/success tokens (never warning/error, which carry status
 * meaning); extra series rotate the primary hue. Missing or invalid tokens fall
 * back to the bundled readable palette so charts stay legible in any theme.
 */
export function resolvePalette(root?: Element | null): string[] {
  const resolved = root ? getComputedStyle(root) : null;
  const palette = PALETTE_TOKENS.map((token) => resolved?.getPropertyValue(token) ?? '');
  const base = palette.map((value, index) => (isValidColor(value) ? value.trim() : FALLBACK_PALETTE[index]!));

  const primary = palette[0] ?? '';
  const canDerive = isValidColor(primary) && supportsRelativeColor();
  const derived = DERIVED_HUE_SHIFTS.map((shift, index) =>
    canDerive ? `oklch(from ${primary.trim()} l c calc(h + ${shift}))` : FALLBACK_PALETTE[PALETTE_TOKENS.length + index]!,
  );
  const muted = resolved?.getPropertyValue('--oc-muted') ?? '';
  const mutedColor = isValidColor(muted) ? muted.trim() : FALLBACK_PALETTE[5]!;

  return [...base, ...derived, mutedColor];
}

function supportsRelativeColor(): boolean {
  return typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('color', 'oklch(from red l c h)');
}

/** The chart palette for the current document, resolved from live host tokens. */
export function hostPalette(): string[] {
  return resolvePalette(typeof document === 'undefined' ? null : document.documentElement);
}
