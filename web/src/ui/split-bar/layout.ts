import type { SplitSegment } from "./split-bar";
export type Slice = {
  id: string;
  start: number;
  end: number;
  share: number;
  on: boolean;
  mode: "full" | "short" | "outside" | "none";
};
export function layoutShares(
  segments: readonly SplitSegment[],
  shares: ReadonlyMap<string, number>,
  active: string | null,
  width: number,
  measure: (text: string) => number,
  percent: Intl.NumberFormat,
): Slice[] {
  const lengths = new Map(shares);
  if (active && width > 0) {
    const original = shares.get(active) ?? 0,
      item = segments.find((s) => s.id === active),
      room = item
        ? (measure(`${item.label} ${percent.format(original)}`) + 30) / width
        : 0,
      expanded = Math.min(
        Math.max(original + 0.045, Math.min(room, 0.42)),
        0.9,
      );
    if (expanded > original && original < 1) {
      const rest = (1 - expanded) / (1 - original);
      for (const [id, value] of lengths)
        lengths.set(id, id === active ? expanded : value * rest);
    }
  }
  let edge = 0;
  return segments.map((item) => {
    const start = edge;
    edge += lengths.get(item.id) ?? 0;
    const end = Math.min(1, edge),
      share = shares.get(item.id) ?? 0,
      on = end > start,
      pixels = (end - start) * width,
      full = measure(`${item.label} ${percent.format(share)}`) + 30,
      short = measure(percent.format(share)) + 26;
    return {
      id: item.id,
      start,
      end,
      share,
      on,
      mode: on
        ? pixels >= full
          ? "full"
          : pixels >= short
            ? "short"
            : "outside"
        : "none",
    };
  });
}
export type Outside = {
  id: string;
  name: string;
  anchor: number;
  width: number;
  x: number;
};
export function outsideLabels(
  segments: readonly SplitSegment[],
  slices: readonly Slice[],
  width: number,
  measure: (text: string) => number,
  percent: Intl.NumberFormat,
): Outside[] {
  const collect = (names: boolean) =>
    slices
      .filter((s) => s.mode === "outside")
      .map((s) => {
        const name = names
            ? (segments.find((item) => item.id === s.id)?.label ?? "")
            : "",
          share = percent.format(s.share);
        return {
          id: s.id,
          name,
          anchor: ((s.start + s.end) / 2) * width,
          width: measure(name ? `${name} ${share}` : share) + 6,
          x: 0,
        };
      });
  let labels = collect(true);
  if (labels.reduce((sum, l, i) => sum + l.width + (i ? 12 : 0), 0) > width)
    labels = collect(false);
  labels.forEach((l, i) => {
    const previous = labels[i - 1];
    l.x = Math.max(
      previous ? previous.x + previous.width + 12 : 0,
      l.anchor - l.width / 2,
    );
  });
  for (let i = labels.length - 1; i >= 0; i--) {
    const l = labels[i],
      next = labels[i + 1],
      limit = next ? next.x - 12 : width;
    if (l && l.x + l.width > limit) l.x = Math.max(0, limit - l.width);
  }
  return labels;
}
