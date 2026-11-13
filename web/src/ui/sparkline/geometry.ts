import {
  gappedArea,
  gappedCurve,
  gappedPath,
  hasValue,
  sampleAt,
  type MaybeValue,
  type Point,
} from "../lib/gapped-series.ts";

/** Space kept above the highest and below the lowest point. */
export const INSET = 5;

/** Present values scaled to 0..1 between their own minimum and maximum (a flat series sits in the middle); gaps stay `null`. */
export function unitValues(values: readonly MaybeValue[]): (number | null)[] {
  const present = values.filter(hasValue);
  if (!present.length) return values.map(() => null);
  const min = Math.min(...present),
    span = Math.max(...present) - min;
  return values.map((value) => (hasValue(value) ? (span ? (value - min) / span : 0.5) : null));
}

/** The smooth line through a series in unit space (x and y both 0 to 1, y up), broken at every missing value. */
export function sparkShape(values: readonly MaybeValue[]): Point[] {
  return gappedCurve(unitValues(values), true, 128);
}

/** Every drawn string for one frame, in the chart's own pixels so strokes and dots stay round at any width. */
export function sparkGeometry(shape: readonly Point[], w: number, h: number, at: number) {
  const toY = (y: number) => INSET + (1 - y) * (h - INSET * 2);
  const pixels = shape.map(([x, y]): Point => [x * w, Number.isFinite(y) ? toY(y) : Number.NaN]);
  const value = sampleAt(shape, at);
  const cx = at * w;
  const cy = Number.isFinite(value) ? toY(value) : Number.NaN;
  return {
    line: gappedPath(pixels),
    fill: gappedArea(pixels, h),
    /** A zero-length round-capped stroke at the cursor, or nothing when the cursor sits in a gap. */
    dot: Number.isFinite(cy) ? `${cx.toFixed(2)},${cy.toFixed(2)} ${cx.toFixed(2)},${cy.toFixed(2)}` : "",
    cx,
  };
}
