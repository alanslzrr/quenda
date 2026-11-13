import { hasValue, type MaybeValue } from "../lib/gapped-series.ts";

export interface BarStats {
  /** Mean of the present values, or `null` when none is present. */
  average: number | null;
  /** Largest present value, and zero when none is; it sets the top of the scale. */
  peak: number;
  /** Index of the first highest and first lowest present value, or -1. */
  highest: number;
  lowest: number;
  /** How many values are present. */
  count: number;
}

/** Summary of a bar series that skips missing values instead of counting them as zero. Sums stay finite near the numeric limit. */
export function barStats(values: readonly MaybeValue[]): BarStats {
  const present: { value: number; index: number }[] = [];
  values.forEach((value, index) => {
    if (hasValue(value)) present.push({ value, index });
  });
  if (!present.length) return { average: null, peak: 0, highest: -1, lowest: -1, count: 0 };
  let total = 0,
    magnitude = 0,
    highest = present[0] ?? { value: 0, index: -1 },
    lowest = highest,
    peak = 0;
  for (const item of present) {
    total += item.value;
    magnitude = Math.max(magnitude, Math.abs(item.value));
    peak = Math.max(peak, item.value);
    if (item.value > highest.value) highest = item;
    if (item.value < lowest.value) lowest = item;
  }
  const average = Number.isFinite(total) || magnitude === 0
    ? total / present.length
    : (present.reduce((sum, item) => sum + item.value / magnitude, 0) / present.length) * magnitude;
  return { average, peak, highest: highest.index, lowest: lowest.index, count: present.length };
}
