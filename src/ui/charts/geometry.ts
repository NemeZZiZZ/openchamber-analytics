/**
 * Pure chart geometry — no DOM dependency, fully unit-tested.
 *
 * All functions guard zero, negative, NaN, and infinite inputs at the trust
 * boundary so renderers never receive invalid coordinates.
 */

export type ScaleDomain = { min: number; max: number };

/** A usable finite number: non-finite and negative values clamp to zero. */
export function safeValue(value: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** The maximum of finite values, guarding empty/zero/negative domains. */
export function numericMax(values: number[]): number {
  let max = 0;

  for (const value of values) {
    if (Number.isFinite(value) && value > max) {
      max = value;
    }
  }

  return max === 0 ? 1 : max;
}

/** One shared zero-to-maximum domain across multiple series. */
export function sharedDomain(series: number[][]): ScaleDomain {
  let max = 0;

  for (const points of series) {
    for (const value of points) {
      if (Number.isFinite(value) && value > max) {
        max = value;
      }
    }
  }

  return { min: 0, max: max === 0 ? 1 : max };
}

/** Linear ticks within the domain; a zero domain produces a single tick. */
export function linearTicks(min: number, max: number, targetCount = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    return [Math.max(0, min)];
  }

  const step = (max - min) / Math.max(1, targetCount);
  const ticks: number[] = [];

  for (let index = 0; index <= targetCount; index += 1) {
    ticks.push(min + step * index);
  }

  return ticks;
}

/** Maps a value onto [0, range] with the domain clamped. */
export function scaleLinear(value: number, domain: ScaleDomain, range: number): number {
  const safe = safeValue(value);
  const span = domain.max - domain.min;

  if (span <= 0) {
    return 0;
  }

  const ratio = (safe - domain.min) / span;
  return range - ratio * range;
}

export type StackResult = {
  keys: string[];
  /** Cumulative tops per series: tops[i][j] is the stacked top of series i at point j. */
  tops: number[][];
  /** Cumulative bases per series: bases[i][j] is where series i starts at point j. */
  bases: number[][];
  /** Additive totals per point; reconcile with the sum of all series. */
  totals: number[];
};

/**
 * Additive stacking over equal-length point arrays (ragged series pad with
 * zeros). The stacked totals reconcile with the sum of every series.
 */
export function stackSeries(series: { key: string; points: number[] }[]): StackResult {
  const keys = series.map((entry) => entry.key);
  const count = series.reduce((acc, entry) => Math.max(acc, entry.points.length), 0);
  const tops: number[][] = [];
  const bases: number[][] = [];
  const totals = new Array<number>(count).fill(0);

  let previous = new Array<number>(count).fill(0);

  for (const entry of series) {
    const top: number[] = [];

    for (let index = 0; index < count; index += 1) {
      const value = safeValue(entry.points[index] ?? 0);
      totals[index] = (totals[index] ?? 0) + value;
      top.push((previous[index] ?? 0) + value);
    }

    bases.push([...previous]);
    tops.push(top);
    previous = top;
  }

  return { keys, tops, bases, totals };
}

/**
 * X-axis label indices capped at roughly eight positions without losing the
 * start/end context: stride sampling plus a guaranteed final index.
 */
export function capXLabelIndices(count: number, maxLabels = 8): number[] {
  if (count <= 0) {
    return [];
  }

  if (count <= maxLabels) {
    return Array.from({ length: count }, (_, index) => index);
  }

  const stride = Math.ceil(count / maxLabels);
  const indices: number[] = [];

  for (let index = 0; index < count - 1; index += stride) {
    indices.push(index);
  }

  const last = count - 1;

  if (indices.at(-1) !== last) {
    if (indices.length >= maxLabels) {
      indices[indices.length - 1] = last;
    } else {
      indices.push(last);
    }
  }

  return indices;
}

export type LinePoint = { x: number; y: number };

/** Straight-segment line points across the plot area (y=0 is the top). */
export function linePoints(values: number[], width: number, height: number, domain: ScaleDomain): LinePoint[] {
  const count = values.length;

  if (count === 0) {
    return [];
  }

  const span = Math.max(1, count - 1);

  return values.map((value, index) => ({
    x: count === 1 ? width / 2 : (index / span) * width,
    y: Math.max(0, Math.min(height, scaleLinear(value, domain, height))),
  }));
}

/** Straight segments between consecutive points. */
export function straightLineSegments(values: number[], width: number, height: number, domain: ScaleDomain): { from: LinePoint; to: LinePoint }[] {
  const points = linePoints(values, width, height, domain);
  const segments: { from: LinePoint; to: LinePoint }[] = [];

  for (let index = 0; index < points.length - 1; index += 1) {
    segments.push({ from: points[index]!, to: points[index + 1]! });
  }

  return segments;
}

/** Compact no-axis sparkline path (SVG path data), bounded by width/height. */
export function sparklinePath(values: number[], width: number, height: number, domain: ScaleDomain): string {
  const points = linePoints(values, width, height, domain);

  if (points.length === 0) {
    return '';
  }

  return points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ');
}

export type DonutArc = {
  fraction: number;
  startAngle: number;
  endAngle: number;
};

/**
 * Donut arc fractions and angles (radians from the 12 o'clock position).
 * The final arc absorbs rounding so fractions sum to exactly one.
 */
export function donutArcs(values: number[]): DonutArc[] {
  const safe = values.map((value) => safeValue(value)).filter((value) => value > 0);
  const total = safe.reduce((acc, value) => acc + value, 0);

  if (total <= 0) {
    return [];
  }

  const arcs: DonutArc[] = [];
  let cursor = -Math.PI / 2;

  for (let index = 0; index < safe.length; index += 1) {
    const isLast = index === safe.length - 1;
    const fraction = isLast ? 1 - arcs.reduce((acc, arc) => acc + arc.fraction, 0) : safe[index]! / total;
    const sweep = fraction * Math.PI * 2;

    arcs.push({
      fraction,
      startAngle: cursor,
      endAngle: cursor + sweep,
    });

    cursor += sweep;
  }

  return arcs;
}

/** Attaches the original-list index to items so sorting never loses identity. */
export function attachIdentity<T>(items: T[]): (T & { seriesIndex: number })[] {
  return items.map((item, seriesIndex) => ({ ...item, seriesIndex }));
}
