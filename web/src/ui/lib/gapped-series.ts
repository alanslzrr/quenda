/** A reading that may be missing: `null`, `undefined` or a non-finite number is a gap, never a zero. */
export type MaybeValue = number | null | undefined;
/** A sampled point in data units. A `NaN` value marks a gap. */
export type Point = [x: number, value: number];
/** An inclusive run of consecutive indexes that all hold a value. */
export interface Run {
  start: number;
  end: number;
}

export const hasValue = (value: MaybeValue): value is number =>
  typeof value === "number" && Number.isFinite(value);

const clamp = (value: number, low: number, high: number) =>
  Math.min(high, Math.max(low, value));

/** Splits a series into its continuous stretches. A single value between two gaps is a run of one. */
export function continuousRuns(values: readonly MaybeValue[]): Run[] {
  const runs: Run[] = [];
  let start = -1;
  values.forEach((value, index) => {
    if (hasValue(value)) {
      if (start < 0) start = index;
    } else if (start >= 0) {
      runs.push({ start, end: index - 1 });
      start = -1;
    }
  });
  if (start >= 0) runs.push({ start, end: values.length - 1 });
  return runs;
}

/** Interpolates opposite extreme values without forming an infinite difference. */
export function mixFinite(from: number, to: number, progress: number) {
  if (Math.max(Math.abs(from), Math.abs(to)) < 1e300)
    return from + (to - from) * progress;
  const t = clamp(progress, 0, 1);
  return from * (1 - t) + to * t;
}

/** Morph step between two sampled values: a gap in the target opens at once, a value arriving from a gap appears in place. */
export function mixGapped(from: number, to: number, progress: number) {
  if (!Number.isFinite(to)) return Number.NaN;
  if (!Number.isFinite(from)) return to;
  return mixFinite(from, to, progress);
}

/** Monotone cubic samples through one run of values, so a smooth curve never swings past the data. */
function smoothRun(values: number[], step: number, samples: number): Point[] {
  const last = values.length - 1;
  const largest = values.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
  const magnitude = largest > 1e300 ? largest : 1;
  const ys = magnitude === 1 ? values : values.map((value) => value / magnitude);
  const at = (index: number) => ys[index] ?? 0;
  const slopes = ys.slice(1).map((value, index) => (value - at(index)) / step);
  const slope = (index: number) => slopes[index] ?? 0;
  const tangents = ys.map((_, index) =>
    index === 0 || index === last
      ? 0
      : (Math.sign(slope(index - 1)) + Math.sign(slope(index))) *
          Math.min(
            Math.abs(slope(index - 1)),
            Math.abs(slope(index)),
            Math.abs(slope(index - 1) + slope(index)) / 4,
          ) || 0,
  );
  if (last > 1) {
    tangents[0] = (3 * slope(0) - (tangents[1] ?? 0)) / 2;
    tangents[last] = (3 * slope(last - 1) - (tangents[last - 1] ?? 0)) / 2;
  } else {
    tangents[0] = slope(0);
    tangents[1] = slope(0);
  }
  const tangent = (index: number) => tangents[index] ?? 0;
  const points: Point[] = [];
  for (let index = 0; index < last; index++) {
    const low = Math.min(at(index), at(index + 1)),
      high = Math.max(at(index), at(index + 1));
    for (let sample = 0; sample < samples; sample++) {
      const t = sample / samples,
        t2 = t * t,
        t3 = t2 * t;
      const value =
        (2 * t3 - 3 * t2 + 1) * at(index) +
        (t3 - 2 * t2 + t) * step * tangent(index) +
        (3 * t2 - 2 * t3) * at(index + 1) +
        (t3 - t2) * step * tangent(index + 1);
      points.push([(index + t) * step, clamp(value, low, high) * magnitude]);
    }
  }
  points.push([last * step, at(last) * magnitude]);
  return points;
}

/**
 * The line through a series, sampled on x from 0 to 1. Every missing index yields one `NaN` point, so the line breaks
 * there and no zero is ever drawn; smoothing never bridges a gap. A lone series value spans the whole width.
 * `density` is roughly how many samples the whole curve gets.
 */
export function gappedCurve(values: readonly MaybeValue[], smooth: boolean, density = 192): Point[] {
  if (values.length === 0) return [];
  if (values.length === 1) {
    const only = values[0];
    return hasValue(only) ? [[0, only], [1, only]] : [];
  }
  const last = values.length - 1,
    step = 1 / last;
  const samples = Math.max(1, Math.min(16, Math.round(density / last)));
  const points: Point[] = [];
  let next = 0;
  for (const run of continuousRuns(values)) {
    for (; next < run.start; next++) points.push([next * step, Number.NaN]);
    const stretch = values.slice(run.start, run.end + 1).filter(hasValue);
    const local: Point[] = smooth && stretch.length > 1
      ? smoothRun(stretch, step, samples)
      : stretch.map((value, index) => [index * step, value]);
    for (const [x, value] of local) points.push([run.start * step + x, value]);
    next = run.end + 1;
  }
  for (; next <= last; next++) points.push([next * step, Number.NaN]);
  return points;
}

/** Value of a sampled line at x, straight between samples; `NaN` inside a gap or for an empty line. */
export function sampleAt(shape: readonly Point[], x: number): number {
  const first = shape[0],
    final = shape[shape.length - 1];
  if (!first || !final) return Number.NaN;
  if (x <= first[0]) return first[1];
  if (x >= final[0]) return final[1];
  let low = 0,
    high = shape.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if ((shape[middle]?.[0] ?? 0) < x) low = middle;
    else high = middle;
  }
  const [x0, y0] = shape[low] ?? first,
    [x1, y1] = shape[high] ?? final;
  if (x === x1 || x1 === x0) return y1;
  if (!Number.isFinite(y0) || !Number.isFinite(y1)) return Number.NaN;
  return mixFinite(y0, y1, (x - x0) / (x1 - x0));
}

const pair = ([x, y]: Point) => `${x.toFixed(1)},${y.toFixed(1)}`;

/** Finite stretches of pixel points, split wherever a point is `NaN`. */
function stretchesOf(points: readonly Point[]) {
  const stretches: Point[][] = [];
  let current: Point[] = [];
  for (const point of points) {
    if (Number.isFinite(point[1]) && Number.isFinite(point[0])) current.push(point);
    else if (current.length) {
      stretches.push(current);
      current = [];
    }
  }
  if (current.length) stretches.push(current);
  return stretches;
}

/** SVG path data with one subpath per stretch. A lone point becomes a zero-length subpath, which a round line cap draws as a dot. */
export function gappedPath(points: readonly Point[]): string {
  return stretchesOf(points)
    .map((stretch) => {
      const [head] = stretch;
      if (!head) return "";
      return stretch.length === 1
        ? `M${pair(head)}L${pair(head)}`
        : `M${stretch.map(pair).join("L")}`;
    })
    .join("");
}

/** SVG path data for the area under each stretch, closed down to `base`. A lone point has no area. */
export function gappedArea(points: readonly Point[], base: number): string {
  const floor = base.toFixed(1);
  return stretchesOf(points)
    .filter((stretch) => stretch.length > 1)
    .map((stretch) => {
      const first = stretch[0],
        last = stretch[stretch.length - 1];
      if (!first || !last) return "";
      return `M${stretch.map(pair).join("L")}L${last[0].toFixed(1)},${floor}L${first[0].toFixed(1)},${floor}Z`;
    })
    .join("");
}

/** Index of the last value at or before `from`, or -1. */
export function lastValueIndex(values: readonly MaybeValue[], from = values.length - 1) {
  for (let index = Math.min(from, values.length - 1); index >= 0; index--)
    if (hasValue(values[index])) return index;
  return -1;
}
