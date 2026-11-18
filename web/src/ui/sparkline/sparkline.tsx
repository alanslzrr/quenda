"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import {
  AnimatePresence,
  animate,
  motion,
  useInView,
  useMotionValue,
  useMotionValueEvent,
  type Variants,
} from "motion/react";
import { chartText } from "../lib/chart-text";
import { hasValue, lastValueIndex, mixGapped, sampleAt, type Point } from "../lib/gapped-series";
import { numberFormat } from "../lib/intl-cache";
import { MISSING_MARK, numberLocales } from "../lib/locale-text";
import { motionTokens } from "../lib/motion-tokens";
import { useLiveReducedMotion } from "../lib/use-live-reduced-motion";
import { sparkGeometry, sparkShape } from "./geometry";
import styles from "./sparkline.module.css";

interface SparklineBaseProps {
  /** One reading per point. `null` (or a non-finite number) is a gap: the line breaks there and readouts say there is no data. */
  data: readonly (number | null)[];
  /** Galician (gl) or Spanish (es) built-in copy and number formatting; any other locale falls back to English copy. */
  locale: string;
  value?: string;
  change?: string;
  tone?: "accent" | "success" | "warning" | "danger";
  /** Drawing width in pixels; with `fixedSize` also the rendered width. */
  width?: number;
  /** Drawing height in pixels; with `fixedSize` also the rendered height. */
  height?: number;
  /** Render at exactly `width` × `height` pixels instead of filling the container's width. */
  fixedSize?: boolean;
  /** One label per point, such as a date. It replaces the change while that point is scrubbed. */
  labels?: readonly string[];
  /** Formats a present point for the headline. Missing points always show "—". Defaults to a grouped number. */
  formatValue?: (value: number, index: number) => string;
  /** A quiet neutral fill under the line. */
  area?: boolean;
  /** Pointer and keyboard scrubbing through the points. Ignored when decorative. */
  interactive?: boolean;
}

/**
 * A small trend line. `decorative` draws only the line, hidden from assistive technology and without a focus stop, for
 * places such as a table row whose text already states the numbers; otherwise `label` names it.
 */
export type SparklineProps = SparklineBaseProps &
  ({ decorative: true; label?: string } | { decorative?: false; label: string });

/** Copy that holds a number enters from the side it moved toward: a larger value rises from below, a smaller one drops from above. */
const rise: Variants = {
  hidden: (direction: number) => ({
    opacity: 0,
    y: `${0.3 * direction}em`,
    filter: `blur(${motionTokens.blur.soft}px)`,
  }),
  shown: {
    opacity: 1,
    y: 0,
    filter: "blur(0px)",
    transition: {
      duration: motionTokens.duration.standard,
      ease: [...motionTokens.ease.enter],
    },
  },
  gone: (direction: number) => ({
    opacity: 0,
    y: `${-0.3 * direction}em`,
    filter: `blur(${motionTokens.blur.subtle}px)`,
    transition: {
      duration: motionTokens.duration.fast,
      ease: [...motionTokens.ease.standard],
    },
  }),
};
const fade: Variants = {
  hidden: { opacity: 0, y: 0, filter: "blur(0px)" },
  shown: {
    opacity: 1,
    y: 0,
    filter: "blur(0px)",
    transition: { duration: motionTokens.duration.instant },
  },
  gone: {
    opacity: 0,
    y: 0,
    filter: "blur(0px)",
    transition: { duration: motionTokens.duration.instant },
  },
};
const amountIn = (text: string) =>
  Number(
    text
      .replace(/,/g, "")
      .replace(/−/g, "-")
      .match(/-?\d+(?:\.\d+)?/)?.[0] ?? NaN,
  );
/** The first draw: one smooth stroke, slow at both ends like a pen. */
const draw = {
  duration: motionTokens.duration.considered * 1.75,
  ease: [...motionTokens.ease.inOut],
} as const;
const quick = {
  duration: motionTokens.duration.fast,
  ease: [...motionTokens.ease.standard],
} as const;

type Chunk = { slot: string; key: string; text: string };
/** A number keeps its unchanged digits still, keyed by place from the right. Words key on everything up to them, so only the first changed word and what follows it roll. */
function chunksOf(text: string, whole: boolean): Chunk[] {
  if (!text) return [];
  if (whole) return [{ slot: "all", key: text, text }];
  if (!/\p{L}/u.test(text))
    return [...text].map((char, index, all) => ({
      slot: `n${all.length - index}`,
      key: char,
      text: char,
    }));
  const words = text.split(/(?<=\s)/);
  return words.map((word, index) => ({
    slot: `w${index}`,
    key: words.slice(0, index + 1).join(""),
    text: word,
  }));
}

/** Text that changes rolls in place, like a numeric content transition; `morph` springs the wrapper to the new width so nothing beside it jumps. */
function Roll({
  text,
  direction,
  whole = false,
  morph = false,
  tone,
}: {
  text: string;
  direction?: number;
  whole?: boolean;
  morph?: boolean;
  tone?: string;
}) {
  const reduceMotion = useLiveReducedMotion();
  const sizer = useRef<HTMLSpanElement>(null);
  const width = useMotionValue<number | "auto">("auto");
  const [shown, setShown] = useState({ text, direction: 1 });
  if (shown.text !== text)
    setShown({
      text,
      direction: direction ?? (amountIn(text) < amountIn(shown.text) ? -1 : 1),
    });
  // biome-ignore lint/correctness/useExhaustiveDependencies: Changing morph replaces the measured element.
  useEffect(() => {
    const node = sizer.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    let measured: string | null = null;
    // Layout size, not the transformed rect, so a scaling parent never leaves the text clipped. Only a new text springs; font loads jump.
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const next = entry.borderBoxSize?.[0]?.inlineSize ?? node.offsetWidth;
      if (measured !== null && measured !== node.textContent && !reduceMotion)
        animate(width, next, motionTokens.spring.morph);
      else width.jump(next);
      measured = node.textContent;
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [morph, reduceMotion, width]);
  const numeric = !whole && !/\p{L}/u.test(text);
  const variants = reduceMotion ? fade : rise;
  const anchor = numeric ? "right" : "left";
  return (
    <motion.span
      className={styles.roll}
      data-end={numeric || undefined}
      data-whole={whole || undefined}
      style={morph ? { width } : undefined}
    >
      {morph && (
        <span ref={sizer} className={styles.sizer} aria-hidden="true">
          {text}
        </span>
      )}
      {/* Expose the current text once while decorative pieces animate in and out. */}
      <span className={styles.srOnly}>{text}</span>
      <span className={styles.track} aria-hidden="true">
        <AnimatePresence
          mode="popLayout"
          initial={false}
          custom={shown.direction}
          anchorX={anchor}
        >
          {chunksOf(text, whole).map((chunk) => (
            <motion.span
              key={chunk.slot}
              className={styles.slot}
              custom={shown.direction}
              variants={variants}
              initial="hidden"
              animate="shown"
              exit="gone"
            >
              <AnimatePresence
                mode="popLayout"
                initial={false}
                custom={shown.direction}
                anchorX={anchor}
              >
                <motion.span
                  key={`${tone ?? ""}${chunk.key}`}
                  className={tone ? `${styles.glyph} ${tone}` : styles.glyph}
                  custom={shown.direction}
                  variants={variants}
                  initial="hidden"
                  animate="shown"
                  exit="gone"
                >
                  {chunk.text}
                </motion.span>
              </AnimatePresence>
            </motion.span>
          ))}
        </AnimatePresence>
      </span>
    </motion.span>
  );
}

const grid = Array.from({ length: 161 }, (_, index) => index / 160);

export function Sparkline(props: SparklineProps) {
  const {
    data,
    locale,
    value,
    change,
    tone = "accent",
    width = 160,
    height = 52,
    fixedSize = false,
    labels,
    formatValue,
    area = true,
  } = props;
  const decorative = props.decorative === true;
  const label = props.label ?? "";
  const interactive = !decorative && (props.interactive ?? true);
  const text = useMemo(() => chartText(locale), [locale]);
  const grouped = useMemo(() => numberFormat(numberLocales(locale)), [locale]);
  const readings = data.map((item) => (hasValue(item) ? item : null));
  // With nothing to draw there is nothing to scrub; a lone point spans the width as a flat line.
  const empty = !readings.some((item) => item !== null);
  const last = Math.max(0, data.length - 1);
  const key = readings.map((item) => (item === null ? "" : String(item))).join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: The key captures every reading, so equal data keeps the same target and never restarts a morph.
  const target = useMemo(() => sparkShape(readings), [key]);
  const uid = `sparkline${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const plot = useRef<HTMLDivElement>(null);
  const inView = useInView(plot, { once: true, amount: 0.5 });
  const reduceMotion = useLiveReducedMotion();
  const [box, setBox] = useState({ w: width, h: height });
  const [active, setActive] = useState<number | null>(null);
  if ((empty || !interactive) && active !== null) setActive(null);
  const [landed, setLanded] = useState(false);
  const index = active === null || empty || !interactive ? null : Math.min(active, last);
  const [moved, setMoved] = useState({ index, direction: 1 });
  if (moved.index !== index)
    setMoved({
      index,
      direction:
        index === null || moved.index === null
          ? 1
          : Math.sign(index - moved.index) || 1,
    });

  const [first] = useState(() => sparkGeometry(target, width, height, 1));
  const shape = useRef(target);
  const size = useRef(box);
  const drawn = useMotionValue(0),
    cursor = useMotionValue(1);
  const line = useMotionValue(first.line),
    fill = useMotionValue(first.fill),
    dot = useMotionValue(first.dot);
  const cursorX = useMotionValue(first.cx),
    lit = useMotionValue(first.cx + 16),
    dim = useMotionValue(first.cx),
    reveal = useMotionValue(0);

  // One writer for every drawn attribute: the morphing shape, the cursor, the reveal and the measured size all repaint through here.
  const paint = useCallback(() => {
    const { w, h } = size.current;
    const next = sparkGeometry(shape.current, w, h, cursor.get());
    line.set(next.line);
    fill.set(next.fill);
    dot.set(next.dot);
    cursorX.set(next.cx);
    lit.set(next.cx + 16);
    dim.set(next.cx);
    // The line and its fill uncover left to right; gaps would break a stroke-length draw, so the reveal runs along x.
    reveal.set(drawn.get() * (w + 32));
  }, [cursor, cursorX, dim, dot, drawn, fill, line, lit, reveal]);
  useMotionValueEvent(cursor, "change", paint);
  useMotionValueEvent(drawn, "change", paint);

  // A fluid sparkline draws in its own pixels: measure the width, keep the height in proportion. A fixed one keeps its size.
  useLayoutEffect(() => {
    const node = plot.current;
    if (fixedSize) {
      setBox((current) => (current.w === width && current.h === height ? current : { w: width, h: height }));
      return;
    }
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const w = node.clientWidth;
      if (w)
        setBox((current) =>
          Math.abs(current.w - w) < 0.5
            ? current
            : { w, h: (w * height) / width },
        );
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [fixedSize, height, width]);
  useLayoutEffect(() => {
    size.current = box;
    paint();
  }, [box, paint]);

  // The line uncovers left to right once it is seen, then the end dot lands.
  useEffect(() => {
    // Reduced motion shows the finished line at once; the dot lands a frame later, after hydration has matched the server.
    if (reduceMotion) {
      drawn.jump(1);
      const frame = requestAnimationFrame(() => setLanded(true));
      return () => cancelAnimationFrame(frame);
    }
    if (!inView) return;
    const controls = animate(drawn, 1, {
      ...draw,
      onComplete: () => setLanded(true),
    });
    return () => controls.stop();
  }, [drawn, inView, reduceMotion]);

  // New data morphs the line from the shape on screen, sampled on shared x positions; a gap in the new data opens at once.
  useEffect(() => {
    const from = shape.current;
    if (from === target) return;
    if (reduceMotion || !from.length || !target.length) {
      shape.current = target;
      paint();
      return;
    }
    const xs = [...new Set([...grid, ...target.map(([x]) => x)])].sort(
      (a, b) => a - b,
    );
    const start = xs.map((x) => sampleAt(from, x)),
      goal = xs.map((x) => sampleAt(target, x));
    const controls = animate(0, 1, {
      ...motionTokens.spring.smooth,
      onUpdate: (progress) => {
        shape.current = xs.map(
          (x, at): Point => [
            x,
            mixGapped(start[at] ?? Number.NaN, goal[at] ?? Number.NaN, progress),
          ],
        );
        paint();
      },
      onComplete: () => {
        shape.current = target;
        paint();
      },
    });
    return () => controls.stop();
  }, [paint, reduceMotion, target]);

  // The cursor springs to the scrubbed point and rides the line between points; leaving sends it home to the latest value.
  useEffect(() => {
    const to = index === null || last === 0 ? 1 : index / last;
    if (reduceMotion) {
      cursor.jump(to);
      return;
    }
    const controls = animate(cursor, to, motionTokens.spring.snappy);
    return () => controls.stop();
  }, [cursor, index, last, reduceMotion]);

  const scrubbing = index !== null;
  const readingAt = (at: number) => readings[at] ?? null;
  /** Visible copy for a point: an em dash when it is missing. */
  const format = (at: number) => {
    const reading = readingAt(at);
    return reading === null
      ? MISSING_MARK
      : formatValue
        ? formatValue(reading, at)
        : grouped.format(reading);
  };
  /** Spoken copy for a point: says there is no data when it is missing. */
  const speak = (at: number) => (readingAt(at) === null ? text.noData : format(at));
  const latest = lastValueIndex(readings);
  const point = empty ? "" : format(index ?? last),
    when = labels?.[index ?? last];
  const headline = value === undefined ? undefined : scrubbing ? point : value;
  const aside =
    index === null
      ? (change ?? "")
      : value === undefined
        ? [point, when].filter(Boolean).join(" · ")
        : (when ?? text.position(index + 1, last + 1));
  const description =
    `${label}: ${value ?? (latest < 0 ? text.noData : format(latest))}. ${change ?? ""}`.trim();
  const pointAt = (clientX: number) => {
    const rect = plot.current?.getBoundingClientRect();
    return rect?.width
      ? Math.max(
          0,
          Math.min(
            last,
            Math.round(((clientX - rect.left) / rect.width) * last),
          ),
        )
      : last;
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && scrubbing) {
      event.preventDefault();
      setActive(null);
      return;
    }
    const from = index ?? last,
      page = Math.max(1, Math.round((last + 1) / 6));
    const next = (
      {
        ArrowLeft: from - 1,
        ArrowDown: from - 1,
        ArrowRight: from + 1,
        ArrowUp: from + 1,
        PageDown: from - page,
        PageUp: from + page,
        Home: 0,
        End: last,
      } as Record<string, number>
    )[event.key];
    if (next === undefined) return;
    event.preventDefault();
    setActive(Math.max(0, Math.min(last, next)));
  };
  const scrub = interactive && !empty
    ? {
        role: "slider",
        tabIndex: 0,
        "aria-label": text.exploreValues(label),
        "aria-valuemin": 1,
        "aria-valuemax": last + 1,
        "aria-valuenow": (index ?? last) + 1,
        "aria-valuetext": `${when ?? (index === null ? text.latest : text.pointOf(index + 1, last + 1))}: ${speak(index ?? last)}`,
        onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
          if (event.pointerType !== "mouse")
            event.currentTarget.setPointerCapture?.(event.pointerId);
          setActive(pointAt(event.clientX));
        },
        onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
          if (event.pointerType === "mouse" || event.buttons)
            setActive(pointAt(event.clientX));
        },
        onPointerUp: (event: PointerEvent<HTMLDivElement>) => {
          if (event.pointerType !== "mouse") setActive(null);
        },
        onPointerLeave: (event: PointerEvent<HTMLDivElement>) => {
          if (event.pointerType === "mouse") setActive(null);
        },
        onPointerCancel: () => setActive(null),
        onBlur: () => setActive(null),
        onKeyDown,
      }
    : {};
  const chart = (
    <div
      ref={plot}
      className={styles.plot}
      data-interactive={(interactive && !empty) || undefined}
      data-fixed={fixedSize || undefined}
      style={fixedSize ? { width, height } : undefined}
      {...scrub}
    >
      <svg
        className={styles.chart}
        style={{ visibility: empty ? "hidden" : undefined }}
        viewBox={`0 0 ${box.w} ${box.h}`}
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          <clipPath id={`${uid}-lit`} clipPathUnits="userSpaceOnUse">
            <motion.rect x={-16} y={-16} width={lit} height={box.h + 32} />
          </clipPath>
          <clipPath id={`${uid}-dim`} clipPathUnits="userSpaceOnUse">
            <motion.rect
              x={dim}
              y={-16}
              width={box.w + 32}
              height={box.h + 32}
            />
          </clipPath>
          <clipPath id={`${uid}-reveal`} clipPathUnits="userSpaceOnUse">
            <motion.rect x={-16} y={-16} width={reveal} height={box.h + 32} />
          </clipPath>
        </defs>
        <line
          className={styles.baseline}
          x1="0"
          y1={box.h - 0.5}
          x2={box.w}
          y2={box.h - 0.5}
        />
        <g clipPath={`url(#${uid}-reveal)`}>
          {area && (
            <motion.path className={`${styles.area} ${styles[tone]}`} d={fill} />
          )}
          {/* While scrubbing, the stretch after the cursor dims, as if the later points have not happened yet. */}
          <motion.path
            className={styles.trail}
            d={line}
            clipPath={`url(#${uid}-dim)`}
            initial={false}
            animate={{ opacity: scrubbing && landed ? 1 : 0 }}
            transition={reduceMotion ? { duration: 0 } : quick}
          />
          <motion.path
            className={[styles.line, styles[tone]].join(" ")}
            d={line}
            clipPath={`url(#${uid}-lit)`}
          />
        </g>
        <motion.line
          className={styles.cursor}
          x1={cursorX}
          x2={cursorX}
          y1={0}
          y2={box.h}
          initial={false}
          animate={{ opacity: scrubbing ? 1 : 0 }}
          transition={reduceMotion ? { duration: 0 } : quick}
        />
        {/* A zero-length round-capped stroke is a true circle, and it takes the line's colour. It rests on the latest point and becomes the scrub handle; inside a gap it has no points and draws nothing. */}
        <motion.polyline
          className={[styles.end, styles[tone]].join(" ")}
          points={dot}
          initial={false}
          animate={{
            opacity: landed ? 1 : 0,
            strokeWidth: landed ? (scrubbing ? 10 : 7) : 0,
          }}
          transition={
            reduceMotion
              ? { duration: 0 }
              : { opacity: quick, strokeWidth: motionTokens.spring.snappy }
          }
          fill="none"
          strokeLinecap="round"
        />
      </svg>
    </div>
  );
  if (decorative)
    return (
      <div className={styles.decorative} data-fixed={fixedSize || undefined} aria-hidden="true">
        {chart}
      </div>
    );
  return (
    <figure className={styles.figure} aria-label={description}>
      <figcaption className={styles.caption}>
        <span className={styles.label}>
          <Roll text={label} whole />
        </span>
        {headline !== undefined && (
          <strong>
            <Roll text={headline} morph />
          </strong>
        )}
        <small className={styles[tone]}>
          <Roll
            text={aside}
            direction={scrubbing ? moved.direction : undefined}
            tone={scrubbing ? styles.point : undefined}
            morph
          />
        </small>
      </figcaption>
      {chart}
    </figure>
  );
}

export default Sparkline;
