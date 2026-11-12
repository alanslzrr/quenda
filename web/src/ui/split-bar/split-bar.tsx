"use client";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type RefObject,
} from "react";
import {
  AnimatePresence,
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
  useTransform,
  type MotionValue,
} from "motion/react";
import { numberLocales } from "../lib/locale-text";
import { motionTokens } from "../motion-tokens";
import { describeShares, readShare, splitBarText } from "./labels";
import { RollingNumber } from "./number";
import { layoutShares, outsideLabels, type Slice } from "./layout";
import styles from "./split-bar.module.css";
export interface SplitSegment {
  id: string;
  /** Name in the bar, the legend and the spoken readout, such as "Canceladas pola persoa titular". */
  label: string;
  /** Count for this share. Zero keeps the segment in the spoken summary but draws nothing. */
  value: number;
  /** Any CSS color. Defaults to the chart series tokens in order. */
  color?: string;
}
/** Shares of one whole, such as reservations by outcome, with counts and percentages read out to assistive technology. */
export interface SplitBarProps {
  segments: readonly SplitSegment[];
  /** Galician (gl) or Spanish (es) built-in copy and number formatting; any other locale falls back to English copy. */
  locale: string;
  title?: string;
  description?: string;
  format?: Intl.NumberFormatOptions;
  /** Unit after each count, such as "reservas". */
  unit?: string;
  /** Headline label for the total. Defaults to a localised "Total". */
  totalLabel?: string;
  hidden?: readonly string[];
  defaultHidden?: readonly string[];
  onHiddenChange?: (hidden: string[]) => void;
  legend?: boolean;
  /** Accessible name. Defaults to the title, else a localised name. */
  label?: string;
  className?: string;
  style?: CSSProperties;
}
const colors = [
  "var(--series-1)",
  "var(--series-2)",
  "var(--series-3)",
  "var(--series-4)",
  "var(--text-muted)",
  "var(--border-strong)",
];
function useTextMeasure(probe: RefObject<HTMLElement | null>) {
  // A computed font string can stay identical while its webfont finishes loading.
  // Invalidate measured widths after readiness instead of retaining fallback-font cache entries.
  const [font, setFont] = useState({ value: "", revision: 0 });
  useEffect(() => {
    let alive = true;
    const read = () => {
      if (alive && probe.current) {
        const value = getComputedStyle(probe.current).font;
        setFont(previous => ({ value, revision: previous.revision + 1 }));
      }
    };
    read();
    document.fonts?.ready.then(read).catch(() => {});
    document.fonts?.addEventListener("loadingdone", read);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(read);
    if (probe.current) observer?.observe(probe.current);
    return () => {
      alive = false;
      observer?.disconnect();
      document.fonts?.removeEventListener("loadingdone", read);
    };
  }, [probe]);
  return useMemo(() => {
    const cache = new Map<string, number>();
    const context = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
    if (context && font.value) context.font = font.value;
    return (text: string) => {
      const found = cache.get(text);
      if (found !== undefined) return found;
      const width = context && font.value ? context.measureText(text).width : text.length * 7;
      cache.set(text, width);
      return width;
    };
  }, [font]);
}

function Segment({
  slice,
  color,
  width,
  active,
  dimmed,
  name,
  formatter,
  reduced,
}: {
  slice: Slice;
  color: string;
  width: MotionValue<number>;
  active: boolean;
  dimmed: boolean;
  name: string;
  formatter: Intl.NumberFormat;
  reduced: boolean;
}) {
  const start = useMotionValue(slice.start),
    end = useMotionValue(slice.end);
  useEffect(() => {
    if (reduced) {
      start.jump(slice.start);
      end.jump(slice.end);
      return;
    }
    const a = animate(start, slice.start, motionTokens.spring.smooth),
      b = animate(end, slice.end, motionTokens.spring.smooth);
    return () => {
      a.stop();
      b.stop();
    };
  }, [slice.start, slice.end, start, end, reduced]);
  const clipPath = useTransform(
      [start, end, width],
      ([a = 0, b = 0, w = 0]: number[]) =>
        `inset(0 calc(${((1 - b) * 100).toFixed(3)}% + ${Math.min(1, (1 - b) * w).toFixed(2)}px) 0 calc(${(a * 100).toFixed(3)}% + ${Math.min(1, a * w).toFixed(2)}px) round 4px)`,
    ),
    capX = useTransform(
      [end, width],
      ([b = 0, w = 0]: number[]) => b * w - 3 - Math.min(1, (1 - b) * w),
    ),
    capOpacity = useTransform(
      [start, end, width],
      ([a = 0, b = 0, w = 0]: number[]) =>
        Math.max(0, Math.min(1, ((b - a) * w - 4) / 6)),
    ),
    insideX = useTransform(
      [start, width],
      ([a = 0, w = 0]: number[]) => a * w + 10,
    ),
    full = slice.mode === "full",
    inside = slice.on && (full || slice.mode === "short");
  return (
    <motion.span
      className={styles.segment}
      data-active={active || undefined}
      data-dimmed={dimmed || undefined}
      style={{ clipPath, ...({ "--seg": color } as CSSProperties) }}
      aria-hidden="true"
    >
      <motion.span
        className={styles.cap}
        style={{ x: capX, opacity: capOpacity }}
      />
      <motion.span
        className={styles.inside}
        style={{ x: insideX }}
        initial={false}
        animate={{ opacity: Number(inside) }}
        transition={{ duration: reduced ? 0 : motionTokens.duration.fast }}
      >
        <motion.span
          className={styles.insideName}
          initial={false}
          animate={{
            opacity: Number(full),
            width: full ? "auto" : 0,
            marginRight: full ? 5 : 0,
          }}
          transition={reduced ? { duration: 0 } : motionTokens.spring.morph}
        >
          {name}
        </motion.span>
        <RollingNumber
          value={slice.share}
          formatter={formatter}
          reduced={reduced}
        />
      </motion.span>
    </motion.span>
  );
}
export function SplitBar({
  segments,
  locale,
  title,
  description,
  format,
  unit,
  totalLabel: totalLabelProp,
  hidden,
  defaultHidden = [],
  onHiddenChange,
  legend = true,
  label,
  className,
  style,
}: SplitBarProps) {
  const text = useMemo(() => splitBarText(locale), [locale]);
  const totalLabel = totalLabelProp ?? text.total;
  const reduced = !!useReducedMotion(),
    headingId = useId(),
    [ownHidden, setOwnHidden] = useState<string[]>(() => [...defaultHidden]),
    excluded = hidden ?? ownHidden,
    off = useMemo(() => new Set(excluded), [excluded]),
    [active, setActive] = useState<string | null>(null),
    [announcement, setAnnouncement] = useState(""),
    [shake, setShake] = useState<{ id: string; key: number } | null>(null),
    bar = useRef<HTMLDivElement>(null),
    probe = useRef<HTMLSpanElement>(null),
    widthValue = useMotionValue(0),
    [width, setWidth] = useState(0);
  const pendingHidden = useRef<{ id: string; desired: boolean; from: string } | null>(null);
  const readingId = useRef<string | null>(null);
  const touchActive = useRef(false);
  useLayoutEffect(() => {
    const node = bar.current;
    if (!node) return;
    const measure = () => {
      widthValue.set(node.clientWidth);
      setWidth(node.clientWidth);
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      const timer = window.setInterval(measure, 200);
      return () => { window.removeEventListener("resize", measure); window.clearInterval(timer); };
    }
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [widthValue]);
  const measureText = useTextMeasure(probe),
    number = useMemo(
      () =>
        new Intl.NumberFormat(numberLocales(locale), {
          maximumFractionDigits: 0,
          ...format,
          numberingSystem: "latn",
        }),
      [locale, format],
    ),
    percent = useMemo(
      () =>
        new Intl.NumberFormat(numberLocales(locale), {
          style: "percent",
          minimumFractionDigits: 1,
          maximumFractionDigits: 1,
          numberingSystem: "latn",
        }),
      [locale],
    ),
    visible = segments.filter((s) => !off.has(s.id) && s.value > 0),
    total = visible.reduce((sum, s) => sum + s.value, 0),
    highlight = active && visible.some((s) => s.id === active) ? active : null,
    share = (segment: SplitSegment) =>
      total > 0 && !off.has(segment.id)
        ? Math.max(0, segment.value) / total
        : 0,
    shares = new Map(segments.map((s) => [s.id, share(s)])),
    slices = layoutShares(
      segments,
      shares,
      highlight,
      width,
      measureText,
      percent,
    ),
    outside = outsideLabels(segments, slices, width, measureText, percent),
    selected = highlight ? segments.find((s) => s.id === highlight) : undefined,
    name = label ?? title ?? text.name,
    color = (s: SplitSegment, i: number) =>
      s.color ?? colors[i % colors.length],
    countText = (value: number) =>
      `${number.format(value)}${unit ? ` ${unit}` : ""}`,
    reading = (segment: SplitSegment) =>
      readShare({ label: segment.label, share: percent.format(share(segment)), count: countText(segment.value) }),
    summary = describeShares(
      name,
      segments
        .filter((s) => !off.has(s.id))
        .map((s) => ({ label: s.label, share: percent.format(share(s)), count: countText(Math.max(0, s.value)) })),
      text.keyHint,
    );
  const hiddenKey = JSON.stringify([...excluded].sort());
  // biome-ignore lint/correctness/useExhaustiveDependencies: The serialised hidden key stands for the hidden set; the announcement waits for the controlled host to apply the change.
  useLayoutEffect(() => {
    const pending = pendingHidden.current;
    if (!pending) return;
    const item = segments.find(segment => segment.id === pending.id && segment.value > 0);
    if (hidden === undefined || !item) { pendingHidden.current = null; return; }
    if (off.has(pending.id) === pending.desired) {
      pendingHidden.current = null;
      readingId.current = null;
      setAnnouncement(pending.desired ? text.hidden(item.label) : text.shown(item.label));
    } else if (hiddenKey !== pending.from) pendingHidden.current = null;
  }, [hiddenKey, hidden, segments]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: The reading is refreshed only when the read segment or the numbers it states change.
  useEffect(() => {
    if (!readingId.current) return;
    if (!selected || selected.id !== readingId.current) { readingId.current = null; setAnnouncement(""); return; }
    setAnnouncement(`${reading(selected)}.`);
  }, [selected?.id, selected?.label, selected?.value, total, number, percent, unit]);
  useEffect(() => {
    const outside = (event: globalThis.PointerEvent) => {
      if (touchActive.current && event.pointerType === "touch" && !bar.current?.contains(event.target as Node)) {
        touchActive.current = false;
        setActive(null);
      }
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, []);
  function changeHidden(next: string[]) {
    if (hidden === undefined) setOwnHidden(next);
    onHiddenChange?.(next);
  }
  function toggle(id: string) {
    const item = segments.find((s) => s.id === id && s.value > 0);
    if (!item) return;
    pendingHidden.current = null;
    if (!off.has(id) && visible.length <= 1) {
      readingId.current = null;
      setShake((previous) => ({ id, key: (previous?.key ?? 0) + 1 }));
      setAnnouncement(text.onlyShare(item.label));
      return;
    }
    const desired = !off.has(id);
    const next = desired ? [...excluded, id] : excluded.filter(x => x !== id);
    if (hidden === undefined) {
      readingId.current = null;
      changeHidden(next);
      setAnnouncement(desired ? text.hidden(item.label) : text.shown(item.label));
    } else {
      pendingHidden.current = { id, desired, from: hiddenKey };
      changeHidden(next);
    }
  }
  function readPointer(event: PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect(),
      x = (event.clientX - rect.left) / rect.width,
      hit = slices.find((s) => s.on && x >= s.start && x < s.end);
    if (hit && hit.id !== active) setActive(hit.id);
  }
  return (
    <figure
      className={[styles.figure, className].filter(Boolean).join(" ")}
      style={style}
      aria-labelledby={title && !label ? headingId : undefined}
      aria-label={label ?? (title ? undefined : name)}
    >
      <span ref={probe} className={styles.probe} aria-hidden="true">
        0
      </span>
      <div className={styles.head}>
        {(title || description) && (
          <div className={styles.heading}>
            {title && (
              <p id={headingId} className={styles.title}>
                {title}
              </p>
            )}
            {description && <p className={styles.description}>{description}</p>}
          </div>
        )}
        <div className={styles.readout} aria-hidden="true">
          <AnimatePresence mode="popLayout" anchorX="right" initial={false}>
            <motion.div
              key={selected?.id ?? "total"}
              className={styles.readoutLine}
              initial={
                reduced
                  ? { opacity: 0 }
                  : {
                      opacity: 0,
                      y: 6,
                      filter: `blur(${motionTokens.blur.subtle}px)`,
                    }
              }
              animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              exit={
                reduced
                  ? { opacity: 0 }
                  : {
                      opacity: 0,
                      y: -6,
                      filter: `blur(${motionTokens.blur.subtle}px)`,
                      transition: { duration: motionTokens.duration.fast },
                    }
              }
              transition={
                reduced
                  ? { duration: 0 }
                  : {
                      ...motionTokens.spring.snappy,
                      opacity: { duration: motionTokens.duration.fast },
                    }
              }
            >
              {selected ? (
                <>
                  <span
                    className={styles.readoutSwatch}
                    style={
                      {
                        "--seg": color(selected, segments.indexOf(selected)),
                      } as CSSProperties
                    }
                  />
                  <span className={styles.readoutName}>{selected.label}</span>
                  <span className={styles.readoutShare}>
                    <RollingNumber
                      value={share(selected)}
                      formatter={percent}
                      reduced={reduced}
                    />
                  </span>
                  <span className={styles.readoutValue}>
                    <RollingNumber
                      value={selected.value}
                      formatter={number}
                      reduced={reduced}
                    />
                    {unit ? ` ${unit}` : ""}
                  </span>
                </>
              ) : (
                <>
                  <span className={styles.readoutName}>{totalLabel}</span>
                  <span className={styles.readoutShare}>
                    <RollingNumber
                      value={total}
                      formatter={number}
                      reduced={reduced}
                    />
                  </span>
                  {unit && <span className={styles.readoutValue}>{unit}</span>}
                </>
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: A focusable reading widget, not a fieldset: arrow keys read each share and Enter shows or hides it. */}
      <div
        ref={bar}
        className={styles.bar}
        data-active={highlight ? "" : undefined}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: The group is a keyboard reading widget, so it takes one tab stop.
        tabIndex={0}
        role="group"
        aria-roledescription={text.roleDescription}
        aria-label={summary}
        onPointerMove={readPointer}
        onPointerDown={(event) => { touchActive.current = event.pointerType === "touch"; readPointer(event); }}
        onPointerLeave={(event) => {
          if (event.pointerType === "mouse") setActive(null);
        }}
        onBlur={() => { readingId.current = null; touchActive.current = false; setActive(null); }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || event.key === "Process" || event.key === "Dead") return;
          const ids = visible.map((s) => s.id);
          if (!ids.length) return;
          const index = highlight ? ids.indexOf(highlight) : -1,
            moves: Record<string, number> = {
              ArrowRight: index + 1,
              ArrowDown: index + 1,
              ArrowLeft: index <= 0 ? ids.length - 1 : index - 1,
              ArrowUp: index <= 0 ? ids.length - 1 : index - 1,
              Home: 0,
              End: ids.length - 1,
            };
          if (event.key === "Escape") {
            readingId.current = null;
            setAnnouncement("");
            setActive(null);
            return;
          }
          if (event.key === "Enter" || event.key === " ") {
            if (highlight) {
              event.preventDefault();
              toggle(highlight);
            }
            return;
          }
          if (!(event.key in moves)) return;
          event.preventDefault();
          const id = ids[((moves[event.key] ?? 0) + ids.length) % ids.length];
          if (!id) return;
          readingId.current = id;
          setActive(id);
          const item = segments.find((s) => s.id === id);
          if (item) setAnnouncement(`${reading(item)}.`);
        }}
      >
        {segments.map((s, i) => {
          const slice = slices[i];
          return slice ? (
          <Segment
            key={s.id}
            slice={slice}
            color={color(s, i)}
            width={widthValue}
            active={highlight === s.id}
            dimmed={!!highlight && highlight !== s.id}
            name={s.label}
            formatter={percent}
            reduced={reduced}
          />
          ) : null;
        })}
      </div>
      <motion.div
        className={styles.lane}
        initial={false}
        animate={{ height: outside.length ? 40 : 0 }}
        transition={reduced ? { duration: 0 } : motionTokens.spring.smooth}
        aria-hidden="true"
      >
        <svg className={styles.leaders} width="100%" height={40} aria-hidden="true">
          <AnimatePresence initial={false}>
            {outside.map((l) => {
              const center = l.x + l.width / 2,
                d = `M${l.anchor.toFixed(1)} 0 C${l.anchor.toFixed(1)} 10 ${center.toFixed(1)} 6 ${center.toFixed(1)} 15`;
              return (
                <motion.path
                  key={l.id}
                  className={styles.leader}
                  style={{ opacity: 1 }}
                  data-dimmed={(highlight && highlight !== l.id) || undefined}
                  initial={{ opacity: 0, d }}
                  animate={{ opacity: 1, d }}
                  exit={{ opacity: 0 }}
                  transition={
                    reduced
                      ? { duration: 0 }
                      : {
                          d: motionTokens.spring.smooth,
                          opacity: { duration: motionTokens.duration.fast },
                        }
                  }
                />
              );
            })}
          </AnimatePresence>
        </svg>
        <AnimatePresence initial={false}>
          {outside.map((l) => (
            <motion.span
              key={l.id}
              className={styles.outside}
              data-dimmed={(highlight && highlight !== l.id) || undefined}
              initial={{ opacity: 0, x: l.x, y: -4 }}
              animate={{ opacity: 1, x: l.x, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={
                reduced
                  ? { duration: 0 }
                  : {
                      ...motionTokens.spring.smooth,
                      opacity: { duration: motionTokens.duration.fast },
                    }
              }
            >
              {l.name && <span className={styles.outsideName}>{l.name}</span>}
              <RollingNumber
                value={shares.get(l.id) ?? 0}
                formatter={percent}
                reduced={reduced}
              />
            </motion.span>
          ))}
        </AnimatePresence>
      </motion.div>
      {legend && (
        <ul className={styles.legend} aria-label={text.segments(name)}>
          {segments.map((s, i) => {
            if (s.value <= 0) return null;
            const on = !off.has(s.id);
            return (
              <li key={s.id}>
                <button
                  type="button"
                  className={styles.legendItem}
                  data-off={!on || undefined}
                  data-active={highlight === s.id || undefined}
                  aria-pressed={on}
                  aria-label={on ? reading(s) : `${s.label}, ${text.notShown}`}
                  style={{ "--seg": color(s, i) } as CSSProperties}
                  onClick={() => toggle(s.id)}
                  onPointerEnter={(event) => {
                    if (event.pointerType === "mouse" && on) setActive(s.id);
                  }}
                  onPointerLeave={(event) => {
                    if (event.pointerType === "mouse") setActive(null);
                  }}
                >
                  <motion.span
                    key={shake?.id === s.id ? shake.key : 0}
                    className={styles.legendLabel}
                    initial={{ x: 0 }}
                    animate={
                      shake?.id !== s.id || reduced
                        ? { x: 0 }
                        : { x: [0, -3, 3, -2, 0] }
                    }
                    transition={{
                      duration: 0.32,
                      ease: motionTokens.ease.standard,
                    }}
                  >
                    <span className={styles.swatch} aria-hidden="true" />
                    <span className={styles.legendName}>{s.label}</span>
                  </motion.span>
                  <span className={styles.legendShare} aria-hidden="true">
                    <AnimatePresence mode="popLayout" initial={false}>
                      {on ? (
                        <motion.span
                          key="on"
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0 }}
                          transition={{
                            duration: reduced ? 0 : motionTokens.duration.fast,
                          }}
                        >
                          <RollingNumber
                            value={share(s)}
                            formatter={percent}
                            reduced={reduced}
                          />
                        </motion.span>
                      ) : (
                        <motion.span
                          key="off"
                          className={styles.legendOff}
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0 }}
                          transition={{
                            duration: reduced ? 0 : motionTokens.duration.fast,
                          }}
                        >
                          {text.off}
                        </motion.span>
                      )}
                    </AnimatePresence>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <p
        className={styles.srOnly}
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {announcement}
      </p>
    </figure>
  );
}
