"use client";

import {
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type Ref,
} from "react";
import {
  AnimatePresence,
  animate,
  motion,
  useInView,
  useMotionValue,
  useMotionValueEvent,
  useSpring,
  useTransform,
  type MotionValue,
} from "motion/react";
import { chartText, withUnit } from "../lib/chart-text";
import {
  gappedArea,
  gappedCurve,
  gappedPath,
  hasValue,
  lastValueIndex,
  mixFinite,
  mixGapped,
  sampleAt,
  type MaybeValue,
  type Point,
} from "../lib/gapped-series";
import { MISSING_MARK, numberLocales } from "../lib/locale-text";
import { motionTokens } from "../lib/motion-tokens";
import { useLiveReducedMotion } from "../lib/use-live-reduced-motion";
import styles from "./line-chart.module.css";

export interface LineChartSeries {
  /** Stable identity. A series keeps its line across data changes, so switching ranges morphs the path instead of redrawing it. */
  key: string;
  /** Name in the legend, the tooltip, and the data table. */
  label: string;
  /** Any CSS color. Defaults to the chart series tokens in order. */
  color?: string;
  /** Draws a dashed stroke, useful for a previous period or a target. */
  dashed?: boolean;
  /** Fills the area under the line with a faint tint of its color. Defaults to true for the first series. */
  area?: boolean;
}

export interface LineChartDatum {
  /** Stable identity, such as an ISO date. */
  key: string;
  /** Full label for the tooltip and screen readers, such as "Tue, Sep 15". */
  label: string;
  /** Short label on the x axis, such as "Sep 15". Leave it out to keep the axis quiet at that point. */
  axisLabel?: string;
  /** One value per series key. `null`, a missing key or a non-finite number is a gap: the line breaks there, no point is drawn, and readouts say there is no data. */
  values: Record<string, MaybeValue>;
}

/** Use a line chart for one or more measures over time, when the shape of the trend matters more than any single value. */
export interface LineChartProps {
  data: LineChartDatum[];
  series: LineChartSeries[];
  /** What is measured, such as "Ocupación". Names the chart for assistive technology. */
  label: string;
  /** Galician (gl) or Spanish (es) built-in copy and number formatting; any other locale falls back to English copy. */
  locale: string;
  /** Unit after each value in the tooltip, such as "%". */
  unit?: string;
  /** Plot height in pixels. The width follows the container. */
  height?: number;
  /** Formats present values in the tooltip and data table. Missing values always show "—". */
  formatValue?: (value: number, series: LineChartSeries) => string;
  /** Formats the value axis. Defaults to a compact number in the locale. */
  formatTick?: (value: number) => string;
  /** Controlled hidden series keys. */
  hiddenSeries?: string[];
  defaultHiddenSeries?: string[];
  onHiddenSeriesChange?: (hidden: string[]) => void;
  /** Called as the crosshair moves, and with null when it leaves. Use it to drive a headline readout. */
  onActiveChange?: (index: number | null, datum: LineChartDatum | null) => void;
  /** Keeps the current lines on screen, dimmed, while the next range loads. */
  loading?: boolean;
  /** Shown when there are no points, or no series has a single value. Defaults to a localised message. */
  emptyLabel?: string;
  /** Series toggles above the plot. Shown by default when there is more than one series. */
  legend?: boolean;
  /** Header of the first column in the data table read by screen readers. Defaults to a localised "Date". */
  categoryLabel?: string;
  /** Smooth monotone curves that never swing past the data, or straight segments. */
  curve?: "smooth" | "linear";
  ref?: Ref<HTMLElement>;
  className?: string;
}

type Track = {
  shape: Point[];
  presence: number;
  fade: { stop: () => void } | null;
};

const { spring, duration, ease } = motionTokens;
/** Motion drops inherited velocity on time-defined springs, so values that retarget mid-flight run the same springs written as stiffness and damping. */
const physical = (
  { visualDuration, bounce }: { visualDuration: number; bounce: number },
  restDelta = 0.001,
) => {
  const root = (2 * Math.PI) / (visualDuration * 1.2);
  return {
    type: "spring" as const,
    stiffness: root * root,
    damping: 2 * (1 - bounce) * root,
    restDelta,
    restSpeed: restDelta * 2,
  };
};
const settle = physical(spring.smooth);
const glide = physical(spring.snappy, 0.0001);
const follow = {
  stiffness: glide.stiffness,
  damping: glide.damping,
  restDelta: 0.01,
};
const draw = {
  duration: duration.considered * 1.75,
  ease: [...ease.inOut],
} as const;
const fadeFast = {
  duration: duration.instant,
  ease: [...ease.standard],
} as const;

/** Room above the top gridline, and the gap between the crosshair and its tooltip. */
const TOP = 12,
  GAP = 14;
const PALETTE = [
  "var(--series-1)",
  "var(--series-2)",
  "var(--series-3)",
  "var(--series-4)",
];
const clamp = (value: number, low: number, high: number) =>
  Math.min(high, Math.max(low, value));
const colorOf = (series: LineChartSeries, index: number) =>
  series.color ?? PALETTE[index % PALETTE.length];
const readValue = (datum: LineChartDatum | undefined, key: string): number | null => {
  const value = datum?.values[key];
  return hasValue(value) ? value : null;
};
const clean = (value: number) => Number(value.toPrecision(12));

/** Fraction of a finite range, scaled before subtraction to avoid overflow. */
function fractionOf(value: number, min: number, max: number) {
  const scale = Math.max(Math.abs(value), Math.abs(min), Math.abs(max), 1);
  const lo = min / scale, span = max / scale - lo;
  return (value / scale - lo) / (span || 1);
}

/** Keep spring inputs bounded when scale endpoints approach the numeric limit. */
function animateScaleValue(value: MotionValue<number>, target: number) {
  const start = value.get();
  if (Math.max(Math.abs(start), Math.abs(target)) < 1e300) return animate(value, target, settle);
  return animate(0, 1, {
    ...settle,
    onUpdate: progress => value.set(mixFinite(start, target, progress)),
    onComplete: () => value.set(target),
  });
}

/** Clean gridlines: the smallest step of 1, 2, 2.5, or 5 that covers the data in four rows or fewer, from zero unless the data dips below it. */
function niceScale(low: number, high: number) {
  const lo = Math.min(0, low),
    hi = Math.max(high, lo + 1);
  const span = hi - lo;
  if (!Number.isFinite(span)) return { min: lo, max: hi, ticks: [lo, ...(lo < 0 && hi > 0 ? [0] : []), hi] };
  const magnitude = 10 ** Math.floor(Math.log10(span / 4));
  for (const factor of [1, 2, 2.5, 5, 10]) {
    const step = factor * magnitude,
      bottom = Math.floor(lo / step) * step,
      top = Math.ceil(hi / step) * step;
    if ((top - bottom) / step <= 4 + 1e-9) {
      const ticks: number[] = [];
      for (let value = bottom; value <= top + step / 2; value += step)
        ticks.push(clean(value));
      return { min: clean(bottom), max: clean(top), ticks };
    }
  }
  return { min: lo, max: hi, ticks: [lo, hi] };
}

/** Tracks are mutable animation state read by the painter, never by render. */
const update = (track: Track, patch: Partial<Track>) =>
  Object.assign(track, patch);

const grid = Array.from({ length: 241 }, (_, index) => index / 240);

const subscribeNothing = () => () => {};
/** Reduced motion is only known in the browser, so the first client render matches the server before it takes effect. */
function useReducedMotionSafe() {
  const hydrated = useSyncExternalStore(
    subscribeNothing,
    () => true,
    () => false,
  );
  return useLiveReducedMotion() && hydrated;
}

type Scale = { min: MotionValue<number>; max: MotionValue<number> };
function useRowY(value: number, scale: Scale, height: number) {
  return useTransform(() => {
    const fraction = fractionOf(value, scale.min.get(), scale.max.get());
    return Math.round(TOP + (1 - fraction) * (height - TOP)) + 0.5;
  });
}

/** A gridline rides the scale, so a taller range slides it down while new rows fade in above. */
function Gridline({
  value,
  scale,
  height,
}: {
  value: number;
  scale: Scale;
  height: number;
}) {
  const y = useRowY(value, scale, height);
  return (
    <motion.line
      className={styles.grid}
      x1={0}
      x2="100%"
      y1={y}
      y2={y}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: fadeFast }}
      transition={{ duration: duration.standard, ease: [...ease.standard] }}
    />
  );
}

function TickLabel({
  value,
  scale,
  height,
  format,
}: {
  value: number;
  scale: Scale;
  height: number;
  format: (value: number) => string;
}) {
  const y = useRowY(value, scale, height);
  return (
    <motion.span
      className={styles.tick}
      style={{ y }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: fadeFast }}
      transition={{ duration: duration.standard, ease: [...ease.standard] }}
    >
      <span className={styles.tickText}>{format(value)}</span>
    </motion.span>
  );
}

/** Axis labels that fit: at most one per 76 pixels, counted back from the latest so the newest date always shows. */
function axisPicks(data: LineChartDatum[], width: number) {
  const labeled = data.flatMap((item, index) =>
    item.axisLabel ? [index] : [],
  );
  if (!width || !labeled.length) return [];
  const room = Math.max(2, Math.floor(width / 76));
  const stride = Math.ceil(labeled.length / room);
  return labeled
    .reverse()
    .filter((_, rank) => rank % stride === 0)
    .reverse();
}

export function LineChart({
  data,
  series,
  label,
  locale,
  unit = "",
  height = 220,
  formatValue,
  formatTick: formatTickProp,
  hiddenSeries,
  defaultHiddenSeries,
  onHiddenSeriesChange,
  onActiveChange,
  loading = false,
  emptyLabel: emptyLabelProp,
  legend,
  categoryLabel: categoryLabelProp,
  curve = "smooth",
  ref,
  className,
}: LineChartProps) {
  const reduced = useReducedMotionSafe();
  const text = useMemo(() => chartText(locale), [locale]);
  const numbers = useMemo(() => {
    const locales = numberLocales(locale);
    return {
      grouped: new Intl.NumberFormat(locales, { maximumFractionDigits: 1 }),
      compact: new Intl.NumberFormat(locales, { notation: "compact", maximumFractionDigits: 1 }),
    };
  }, [locale]);
  const formatTick = formatTickProp ?? ((value: number) => numbers.compact.format(value));
  const emptyLabel = emptyLabelProp ?? text.empty;
  const categoryLabel = categoryLabelProp ?? text.date;
  const figure = useRef<HTMLElement>(null);
  const plot = useRef<HTMLDivElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const clip = useRef<SVGRectElement>(null);
  const crosshair = useRef<SVGLineElement>(null);
  const lines = useRef(new Map<string, SVGPathElement>());
  const areas = useRef(new Map<string, SVGPathElement>());
  const dots = useRef(new Map<string, SVGCircleElement>());
  const groups = useRef(new Map<string, SVGGElement>());
  useImperativeHandle(ref, () => figure.current as HTMLElement);
  const inView = useInView(figure, { once: true, amount: 0.3 });
  const uid = `line${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const last = data.length - 1;
  const empty = data.length === 0;

  // Hidden series, controlled or not.
  const [ownHidden, setOwnHidden] = useState<string[]>(
    defaultHiddenSeries ?? [],
  );
  const hidden = hiddenSeries ?? ownHidden;
  const toggle = (key: string) => {
    const next = hidden.includes(key)
      ? hidden.filter((item) => item !== key)
      : [...hidden, key];
    if (hiddenSeries === undefined) setOwnHidden(next);
    onHiddenSeriesChange?.(next);
  };
  const visible = series.filter((item) => !hidden.includes(item.key));
  const showLegend = legend ?? series.length > 1;

  // Each series becomes a dense curve in data units, broken wherever a value is missing; the scale fits only the values on show.
  const signature = JSON.stringify([
    curve,
    series.map((item) => item.key),
    data.map((item) => [
      item.key,
      series.map((line) => String(readValue(item, line.key) ?? "-")),
    ]),
  ]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: The signature captures every input of the curves, so equal data keeps the same targets and never restarts a morph.
  const targets = useMemo(
    () =>
      new Map(
        series.map((line) => [
          line.key,
          gappedCurve(
            data.map((item) => readValue(item, line.key)),
            curve === "smooth",
          ),
        ]),
      ),
    [signature],
  );
  let low = Infinity,
    high = -Infinity;
  for (const line of visible)
    for (const item of data) {
      const value = readValue(item, line.key);
      if (value === null) continue;
      low = Math.min(low, value);
      high = Math.max(high, value);
    }
  const noValues =
    !empty && !series.some((line) => data.some((item) => readValue(item, line.key) !== null));
  const range = Number.isFinite(low) ? niceScale(low, high) : null;
  const [steady, setSteady] = useState(() => range ?? niceScale(0, 100));
  if (range && (range.min !== steady.min || range.max !== steady.max))
    setSteady(range);
  const scale = {
    min: useMotionValue(steady.min),
    max: useMotionValue(steady.max),
  };

  // Scrubbing: a new range lets go of the crosshair.
  const [active, setActive] = useState<number | null>(null);
  const [seenSignature, setSeenSignature] = useState(signature);
  if (seenSignature !== signature) {
    setSeenSignature(signature);
    setActive(null);
  }
  const index = active === null || empty ? null : Math.min(active, last);
  const scrubbing = index !== null;

  const width = useRef(0);
  const [plotWidth, setPlotWidth] = useState(0);
  const tipSize = useRef({ w: 0, h: 0 });
  const tracks = useRef(new Map<string, Track>());
  const drawn = useMotionValue(0);
  const cursor = useMotionValue(1);
  const tipTargetX = useMotionValue(0),
    tipTargetY = useMotionValue(0);
  const tipSpringX = useSpring(tipTargetX, follow),
    tipSpringY = useSpring(tipTargetY, follow);
  const live = useRef({ series, hidden });
  useLayoutEffect(() => {
    live.current = { series, hidden };
  });

  // One writer for every drawn attribute: morphs, toggles, the scale, the crosshair, and the measured size all repaint through here.
  const paint = useCallback(() => {
    const w = width.current;
    if (!w) return;
    const lo = scale.min.get(), hi = scale.max.get();
    const toY = (value: number, presence = 1) =>
      TOP + (1 - fractionOf(value, lo, hi) * presence) * (height - TOP);
    const at = cursor.get();
    const dotYs: number[] = [];
    for (const line of live.current.series) {
      const track = tracks.current.get(line.key);
      if (!track) continue;
      const p = track.presence;
      const y = (value: number) => toY(value, p);
      // Gaps stay NaN in pixels too, so each continuous stretch becomes its own subpath and area.
      const pixels = track.shape.map(([x, value]): Point => [x * w, Number.isFinite(value) ? y(value) : Number.NaN]);
      lines.current.get(line.key)?.setAttribute("d", gappedPath(pixels));
      areas.current.get(line.key)?.setAttribute("d", gappedArea(pixels, height));
      const group = groups.current.get(line.key);
      if (group) group.style.opacity = String(p);
      const dot = dots.current.get(line.key);
      if (dot) {
        const value = sampleAt(track.shape, at);
        if (Number.isFinite(value)) {
          const cy = y(value);
          dot.removeAttribute("data-gap");
          dot.setAttribute("cx", (at * w).toFixed(1));
          dot.setAttribute("cy", cy.toFixed(1));
          if (p > 0.5) dotYs.push(cy);
        } else dot.setAttribute("data-gap", "");
      }
    }
    clip.current?.setAttribute("width", String(drawn.get() * (w + 16)));
    const cx = Math.round(at * w) + 0.5;
    crosshair.current?.setAttribute("x1", String(cx));
    crosshair.current?.setAttribute("x2", String(cx));
    // The tooltip sits beside the crosshair, flips sides before it would leave the plot, and centres on the points it describes.
    const { w: tw, h: th } = tipSize.current;
    let x = cx + GAP;
    if (x + tw > w) x = cx - GAP - tw;
    tipTargetX.set(clamp(x, 0, Math.max(0, w - tw)));
    const middle = dotYs.length
      ? dotYs.reduce((sum, value) => sum + value, 0) / dotYs.length
      : height / 2;
    tipTargetY.set(clamp(middle - th / 2, 0, Math.max(0, height - th)));
  }, [cursor, drawn, height, scale.max, scale.min, tipTargetX, tipTargetY]);
  useMotionValueEvent(cursor, "change", paint);
  useMotionValueEvent(drawn, "change", paint);
  useMotionValueEvent(scale.min, "change", paint);
  useMotionValueEvent(scale.max, "change", paint);
  useLayoutEffect(paint);

  // The plot draws in its own pixels: measure the width, follow resizes, and size the tooltip for its flip.
  useLayoutEffect(() => {
    const node = plot.current,
      bubble = tip.current;
    if (!node) return;
    const read = () => {
      width.current = node.clientWidth;
      setPlotWidth(node.clientWidth);
      if (bubble)
        tipSize.current = { w: bubble.offsetWidth, h: bubble.offsetHeight };
      paint();
    };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(node);
    if (bubble) observer.observe(bubble);
    return () => observer.disconnect();
  }, [paint]);

  // New data morphs every line from the shape on screen, sampled on shared x positions so a range that gains or loses points still flows.
  const morph = useRef<{ stop: () => void } | null>(null);
  useEffect(() => {
    const moves: {
      track: Track;
      xs: number[];
      from: number[];
      to: number[];
      target: Point[];
    }[] = [];
    for (const [key, target] of targets) {
      const track = tracks.current.get(key);
      if (!track) {
        tracks.current.set(key, {
          shape: target,
          presence: live.current.hidden.includes(key) ? 0 : 1,
          fade: null,
        });
        continue;
      }
      if (!track.shape.length || !target.length || reduced) {
        update(track, { shape: target });
        continue;
      }
      const xs = [...new Set([...grid, ...target.map(([x]) => x)])].sort(
        (a, b) => a - b,
      );
      moves.push({
        track,
        xs,
        from: xs.map((x) => sampleAt(track.shape, x)),
        to: xs.map((x) => sampleAt(target, x)),
        target,
      });
    }
    morph.current?.stop();
    if (!moves.length) {
      paint();
      return;
    }
    morph.current = animate(0, 1, {
      ...settle,
      restDelta: 0.0005,
      onUpdate: (progress) => {
        for (const move of moves)
          update(move.track, {
            shape: move.xs.map(
              (x, at): Point => [
                x,
                mixGapped(move.from[at] ?? Number.NaN, move.to[at] ?? Number.NaN, progress),
              ],
            ),
          });
        paint();
      },
      onComplete: () => {
        for (const move of moves) update(move.track, { shape: move.target });
        paint();
      },
    });
    return () => morph.current?.stop();
  }, [paint, reduced, targets]);

  // A hidden series flattens into the baseline as it fades; the ones that stay rescale around it.
  const hiddenKey = JSON.stringify(hidden);
  // biome-ignore lint/correctness/useExhaustiveDependencies: The serialised key stands for the hidden list, so a new array with the same keys does not restart the fades.
  useEffect(() => {
    for (const [key, track] of tracks.current) {
      const to = hidden.includes(key) ? 0 : 1;
      if (track.presence === to) continue;
      track.fade?.stop();
      if (reduced) {
        update(track, { presence: to });
        continue;
      }
      update(track, {
        fade: animate(track.presence, to, {
          ...settle,
          onUpdate: (value) => {
            update(track, { presence: value });
            paint();
          },
        }),
      });
    }
    paint();
  }, [hiddenKey, paint, reduced]);

  useEffect(() => {
    if (reduced) {
      scale.min.jump(steady.min);
      scale.max.jump(steady.max);
      return;
    }
    const controls = [
      animateScaleValue(scale.min, steady.min),
      animateScaleValue(scale.max, steady.max),
    ];
    return () => {
      for (const control of controls) control.stop();
    };
  }, [reduced, scale.max, scale.min, steady]);

  // The lines draw left to right the first time the chart is seen with data.
  useEffect(() => {
    if (empty) return;
    if (reduced) {
      drawn.jump(1);
      return;
    }
    if (!inView || drawn.get() >= 1) return;
    const controls = animate(drawn, 1, draw);
    return () => controls.stop();
  }, [drawn, empty, inView, reduced]);

  // The crosshair appears on the first scrubbed point and glides between the ones after it; the tooltip follows on its own spring.
  const wasScrubbing = useRef(false);
  useEffect(() => {
    if (index === null) {
      wasScrubbing.current = false;
      return;
    }
    const to = last > 0 ? index / last : 0.5;
    if (reduced || !wasScrubbing.current) {
      cursor.jump(to);
      tipSpringX.jump(tipTargetX.get());
      tipSpringY.jump(tipTargetY.get());
    }
    wasScrubbing.current = true;
    if (reduced) return;
    const controls = animate(cursor, to, glide);
    return () => controls.stop();
  }, [
    cursor,
    index,
    last,
    reduced,
    tipSpringX,
    tipSpringY,
    tipTargetX,
    tipTargetY,
  ]);

  const onActive = useRef(onActiveChange);
  useLayoutEffect(() => {
    onActive.current = onActiveChange;
  });
  // Keep host readouts in sync with the selected datum, including metadata or
  // values outside the plotted series, without emitting for equivalent objects.
  const activeDatum = index === null ? null : (data[index] ?? null);
  const activeSignature = activeDatum ? JSON.stringify([
    activeDatum.key, activeDatum.label, activeDatum.axisLabel,
    Object.entries(activeDatum.values).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => [key, String(value)]),
  ]) : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: The signature stands for the active datum, so an equal datum object does not emit again.
  useEffect(() => {
    onActive.current?.(index, activeDatum);
  }, [index, activeSignature]);

  const pointAt = (clientX: number) => {
    const rect = plot.current?.getBoundingClientRect();
    if (!rect?.width || last < 1) return Math.max(0, last);
    return clamp(
      Math.round(((clientX - rect.left) / rect.width) * last),
      0,
      last,
    );
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && scrubbing) {
      event.preventDefault();
      setActive(null);
      return;
    }
    const from = index ?? last + 1,
      page = Math.max(1, Math.round(data.length / 6));
    const next = (
      {
        ArrowLeft: from - 1,
        ArrowDown: from - 1,
        ArrowRight: index === null ? last : from + 1,
        ArrowUp: index === null ? last : from + 1,
        PageDown: from - page,
        PageUp: from + page,
        Home: 0,
        End: last,
      } as Record<string, number>
    )[event.key];
    if (next === undefined || empty) return;
    event.preventDefault();
    setActive(clamp(next, 0, last));
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (empty) return;
    if (event.pointerType !== "mouse")
      event.currentTarget.setPointerCapture?.(event.pointerId);
    setActive(pointAt(event.clientX));
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!empty && (event.pointerType === "mouse" || event.buttons))
      setActive(pointAt(event.clientX));
  };

  /** Visible copy: a missing value is an em dash, never a zero. */
  const format = (value: number | null, line: LineChartSeries) =>
    value === null
      ? MISSING_MARK
      : withUnit(formatValue ? formatValue(value, line) : numbers.grouped.format(value), unit);
  /** Spoken copy: a missing value says there is no data. */
  const speak = (value: number | null, line: LineChartSeries) =>
    value === null ? text.noData : format(value, line);
  const reading = index === null ? null : (data[index] ?? null);
  const valueText = reading
    ? `${reading.label}: ${visible.map((line) => `${line.label} ${speak(readValue(reading, line.key), line)}`).join(", ")}`
    : empty
      ? emptyLabel
      : text.seriesShown(visible.length, series.length);
  const firstDatum = data[0],
    lastDatum = data[last];
  const latestOf = (line: LineChartSeries) => {
    const at = lastValueIndex(data.map((item) => readValue(item, line.key)));
    const datum = data[at];
    return datum
      ? text.latestValue(line.label, format(readValue(datum, line.key), line), at === last ? undefined : datum.label)
      : `${line.label}, ${text.noData}`;
  };
  const summary =
    !firstDatum || !lastDatum
      ? `${label}. ${emptyLabel}.`
      : `${label}, ${text.span(firstDatum.label, lastDatum.label)}. ${visible.map(latestOf).join(". ")}.`;
  const picks = axisPicks(data, plotWidth);
  const allHidden = !empty && visible.length === 0;
  const tipX = reduced ? tipTargetX : tipSpringX,
    tipY = reduced ? tipTargetY : tipSpringY;

  return (
    <figure
      ref={figure}
      className={[styles.figure, className].filter(Boolean).join(" ")}
      aria-label={label}
      aria-busy={loading || undefined}
    >
      {showLegend && (
        // biome-ignore lint/a11y/useSemanticElements: A named group of series toggles, not form fields.
        <div
          className={styles.legend}
          role="group"
          aria-label={text.seriesGroup(label)}
        >
          {series.map((line, at) => (
            <button
              key={line.key}
              type="button"
              className={styles.toggle}
              aria-pressed={!hidden.includes(line.key)}
              onClick={() => toggle(line.key)}
              style={{ "--series": colorOf(line, at) } as CSSProperties}
            >
              <span
                className={styles.swatch}
                data-dashed={line.dashed || undefined}
                aria-hidden="true"
              />
              <span className={styles.toggleLabel}>{line.label}</span>
            </button>
          ))}
        </div>
      )}
      <div
        className={styles.chart}
        data-scrubbing={scrubbing || undefined}
        data-loading={loading || undefined}
      >
        {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole lint/a11y/noStaticElementInteractions: The plot is a keyboard and pointer slider whenever it has points; with none it is an unlabelled, inert box. */}
        <div
          ref={plot}
          className={styles.plot}
          style={{ height }}
          role={empty ? undefined : "slider"}
          tabIndex={empty ? -1 : 0}
          aria-label={empty ? undefined : text.explore(label, categoryLabel)}
          aria-orientation={empty ? undefined : "horizontal"}
          aria-valuemin={empty ? undefined : 1}
          aria-valuemax={empty ? undefined : data.length}
          aria-valuenow={empty ? undefined : (index ?? last) + 1}
          aria-valuetext={empty ? undefined : valueText}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={(event) => {
            if (event.pointerType !== "mouse") setActive(null);
          }}
          onPointerCancel={() => setActive(null)}
          onPointerLeave={(event) => {
            if (event.pointerType === "mouse") setActive(null);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => setActive(null)}
          onFocus={(event) => {
            if (event.currentTarget.matches(":focus-visible") && !empty)
              setActive((current) => current ?? last);
          }}
        >
          <svg
            className={styles.svg}
            width="100%"
            height={height}
            aria-hidden="true"
            focusable="false"
          >
            <defs>
              <clipPath id={`${uid}-draw`} clipPathUnits="userSpaceOnUse">
                <rect
                  ref={clip}
                  x={-8}
                  y={-16}
                  width={0}
                  height={height + 32}
                />
              </clipPath>
            </defs>
            <AnimatePresence initial={false}>
              {steady.ticks.slice(1).map((value) => (
                <Gridline
                  key={value}
                  value={value}
                  scale={scale}
                  height={height}
                />
              ))}
            </AnimatePresence>
            <line
              className={styles.baseline}
              x1={0}
              x2="100%"
              y1={height - 0.5}
              y2={height - 0.5}
            />
            <line
              ref={crosshair}
              className={styles.crosshair}
              y1={TOP - 4}
              y2={height}
            />
            <g className={styles.series} clipPath={`url(#${uid}-draw)`}>
              {series.map((line, at) => (
                <g
                  key={line.key}
                  ref={(node) => {
                    if (node) groups.current.set(line.key, node);
                    else groups.current.delete(line.key);
                  }}
                  style={{ "--series": colorOf(line, at) } as CSSProperties}
                >
                  {(line.area ?? at === 0) && (
                    <path
                      ref={(node) => {
                        if (node) areas.current.set(line.key, node);
                        else areas.current.delete(line.key);
                      }}
                      className={styles.area}
                    />
                  )}
                  <path
                    ref={(node) => {
                      if (node) lines.current.set(line.key, node);
                      else lines.current.delete(line.key);
                    }}
                    className={styles.line}
                    data-dashed={line.dashed || undefined}
                  />
                </g>
              ))}
            </g>
            {series.map((line, at) => (
              <circle
                key={line.key}
                ref={(node) => {
                  if (node) dots.current.set(line.key, node);
                  else dots.current.delete(line.key);
                }}
                className={styles.dot}
                r={4}
                data-hidden={hidden.includes(line.key) || undefined}
                style={{ "--series": colorOf(line, at) } as CSSProperties}
              />
            ))}
          </svg>
          <motion.div
            ref={tip}
            className={styles.tooltip}
            style={{ x: tipX, y: tipY }}
            aria-hidden="true"
          >
            <p className={styles.tipTitle}>
              {(reading ?? lastDatum)?.label ?? ""}
            </p>
            {visible.map((line) => (
              <p
                key={line.key}
                className={styles.tipRow}
                style={
                  {
                    "--series": colorOf(line, series.indexOf(line)),
                  } as CSSProperties
                }
              >
                <span
                  className={styles.tipSwatch}
                  data-dashed={line.dashed || undefined}
                />
                <span className={styles.tipName}>{line.label}</span>
                <span className={styles.tipValue}>
                  {format(readValue(reading ?? lastDatum, line.key), line)}
                </span>
              </p>
            ))}
          </motion.div>
          <AnimatePresence initial={false}>
            {(empty || noValues || allHidden) && !loading && (
              <motion.p
                key={empty || noValues ? "empty" : "hidden"}
                className={styles.message}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0, transition: fadeFast }}
              >
                {empty || noValues ? emptyLabel : text.chooseSeries}
              </motion.p>
            )}
            {loading && empty && (
              <motion.span
                key="skeleton"
                className={styles.skeleton}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0, transition: fadeFast }}
                aria-hidden="true"
              />
            )}
          </AnimatePresence>
        </div>
        <div className={styles.gutter} aria-hidden="true">
          <AnimatePresence initial={false}>
            {steady.ticks.map((value) => (
              <TickLabel
                key={value}
                value={value}
                scale={scale}
                height={height}
                format={formatTick}
              />
            ))}
          </AnimatePresence>
        </div>
        <div className={styles.axis} aria-hidden="true">
          <AnimatePresence initial={false}>
            {picks.map((at) => {
              const share = last > 0 ? at / last : 0.5;
              const datum = data[at];
              if (!datum) return null;
              return (
                <motion.span
                  key={`${datum.key}:${datum.axisLabel}`}
                  className={styles.axisLabel}
                  style={{
                    left: `${share * 100}%`,
                    translateX: `${-share * 100}%`,
                  }}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0, transition: fadeFast }}
                  transition={{
                    duration: duration.standard,
                    ease: [...ease.standard],
                  }}
                >
                  {datum.axisLabel}
                </motion.span>
              );
            })}
          </AnimatePresence>
        </div>
      </div>
      <p className={styles.srOnly}>{summary}</p>
      {!empty && (
        <div className={styles.srOnly}><table>
          <caption>{label}</caption>
          <thead>
            <tr>
              <th scope="col">{categoryLabel}</th>
              {series.map((line) => (
                <th key={line.key} scope="col">
                  {line.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.map((item) => (
              <tr key={item.key}>
                <th scope="row">{item.label}</th>
                {series.map((line) => {
                  const value = readValue(item, line.key);
                  return (
                    <td key={line.key}>
                      {format(value, line)}
                      {value === null && <span className={styles.srOnly}> ({text.noData})</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
      <p className={styles.srOnly} aria-live="polite" aria-atomic="true">
        {loading ? text.loading : ""}
      </p>
    </figure>
  );
}

export default LineChart;
