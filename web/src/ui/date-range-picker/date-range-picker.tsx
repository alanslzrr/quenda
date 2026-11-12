// biome-ignore-all lint/suspicious/noArrayIndexKey: Week rows, highlight bars and rolling words keep positional identity so they glide instead of remounting.
"use client";

import { forwardRef, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, CSSProperties, FocusEvent as ReactFocusEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { AnimatePresence, animate, motion, useIsPresent, useMotionValue, useTransform } from "motion/react";
import type { HTMLMotionProps, Transition, Variants } from "motion/react";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { motionTokens } from "../lib/motion-tokens";
import { useToday } from "../lib/use-today";
import { useLiveReducedMotion } from "../lib/use-live-reduced-motion";
import { CalendarDays } from "../calendar/calendar-days-icon";
import { dateRangeText, formatRangeShort, formatRangeSpoken, type DateRange } from "./labels";
import styles from "./date-range-picker.module.css";

export type { DateRange } from "./labels";

/** A shortcut in the preset rail. `range` receives the viewer's local today and returns an inclusive range. Presets outside minDate/maxDate are disabled, not silently clipped. */
export interface DateRangePreset {
  label: string;
  range: (today: Date) => DateRange;
}

/**
 * A range picker whose trigger grows into the panel it opens. The panel shows two months beside a preset rail, or one
 * month with a scrolling preset row when space is tight. The range highlight stretches across each week as you hover
 * or move with the keyboard, the ends glide between days, months slide in the direction you travel, and on Apply the
 * formatted label flies back into the trigger as the surface shrinks around it.
 * Use it for reports, filters, and bookings where a start and end date are chosen together.
 */
export interface DateRangePickerProps {
  /** Controlled value with an inclusive end day. Pass `null` for no selection. */
  value?: DateRange | null;
  /** Uncontrolled starting value. */
  defaultValue?: DateRange | null;
  /** Called with the applied range; the end day is inclusive. */
  onChange?: (range: DateRange) => void;
  /** Accessible name of the trigger and the dialog. Defaults to a localised "Date range". */
  label?: string;
  /** Trigger text with no selection. Defaults to a localised "Select dates". */
  placeholder?: string;
  /** Shortcuts with caller-written labels. Pass an empty array for none. */
  presets: DateRangePreset[];
  minDate?: Date;
  maxDate?: Date;
  /** 0 is Sunday, 1 is Monday. Defaults to 1. */
  weekStartsOn?: 0 | 1;
  /** Galician (gl) or Spanish (es) copy, dates and day names; any other locale falls back to English. */
  locale: string;
  /** Force one or two months. `auto` picks two when the boundary is wide enough. */
  months?: "auto" | 1 | 2;
  /** The element the panel should stay inside. Defaults to the viewport. */
  boundary?: () => HTMLElement | null;
  className?: string;
}

type Size = { w: number; h: number };
type Bezier = [number, number, number, number];

const DAY = 864e5;
const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
const monthStart = (date: Date) => new Date(date.getFullYear(), date.getMonth(), 1);
const monthEnd = (date: Date) => new Date(date.getFullYear(), date.getMonth() + 1, 0);
const addDays = (date: Date, amount: number) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + amount);
const addMonths = (date: Date, amount: number) => new Date(date.getFullYear(), date.getMonth() + amount, 1);
const shiftMonths = (date: Date, amount: number) => new Date(date.getFullYear(), date.getMonth() + amount, Math.min(date.getDate(), new Date(date.getFullYear(), date.getMonth() + amount + 1, 0).getDate()));
const dayDiff = (a: Date, b: Date) => Math.round((startOfDay(a).getTime() - startOfDay(b).getTime()) / DAY);
const monthDiff = (a: Date, b: Date) => (a.getFullYear() - b.getFullYear()) * 12 + a.getMonth() - b.getMonth();
const sameDay = (a?: Date | null, b?: Date | null) => Boolean(a && b && dayDiff(a, b) === 0);
const keyOf = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const fromKey = (key: string) => { const [year = 1970, month = 1, day = 1] = key.split("-").map(Number); return new Date(year, month - 1, day); };
const ordered = (a: Date, b: Date): DateRange => dayDiff(a, b) <= 0 ? { start: a, end: b } : { start: b, end: a };
const sameRange = (a?: DateRange | null, b?: DateRange | null) => Boolean(a && b && sameDay(a.start, b.start) && sameDay(a.end, b.end));
const clampDate = (date: Date, min?: Date, max?: Date) => min && dayDiff(date, min) < 0 ? startOfDay(min) : max && dayDiff(date, max) > 0 ? startOfDay(max) : date;

const { blur } = motionTokens;
const enterEase = [...motionTokens.ease.enter] as Bezier;
const standardEase = [...motionTokens.ease.standard] as Bezier;
/** Duration springs restated as stiffness and damping, so every retarget keeps the velocity already in flight. */
const physical = (visualDuration: number, bounce: number): Transition => {
  const root = 2 * Math.PI / (visualDuration * 1.2);
  return { type: "spring", stiffness: root * root, damping: 2 * (1 - bounce) * root, mass: 1 };
};
const GROW = physical(.48, .12), SHRINK = physical(.38, 0), STRETCH = physical(.3, .04), GLIDE = physical(.3, .1), SLIDE = physical(.4, .06);
const TRIGGER_RADIUS = 18, PANEL_RADIUS = 26, WIDE_CELL = 36, WIDE_MIN = 712, EDGE = 8;

const roll: Variants = {
  enter: (direction: number) => ({ opacity: 0, y: `${direction * .45}em`, filter: `blur(${blur.subtle}px)` }),
  center: { opacity: 1, y: "0em", filter: "blur(0px)", transition: { duration: .26, ease: enterEase } },
  exit: (direction: number) => ({ opacity: 0, y: `${direction * -.45}em`, filter: `blur(${blur.subtle}px)`, transition: { duration: .14, ease: standardEase } }),
};
const fade: Variants = { enter: { opacity: 0 }, center: { opacity: 1, y: "0em", filter: "blur(0px)", transition: { duration: .12 } }, exit: { opacity: 0, transition: { duration: .08 } } };
/** Panel content arrives just behind the growing surface and leaves ahead of it. */
const faceIn: Variants = {
  hidden: { opacity: 0, y: -4, filter: `blur(${blur.soft}px)` },
  shown: { opacity: 1, y: 0, filter: "blur(0px)", transition: { duration: .26, ease: enterEase, delay: .07 } },
  gone: { opacity: 0, y: -2, filter: `blur(${blur.soft}px)`, transition: { duration: .12, ease: standardEase } },
};
const faceFade: Variants = { hidden: { opacity: 0 }, shown: { opacity: 1, transition: { duration: .12 } }, gone: { opacity: 0, transition: { duration: .08 } } };
const slide: Variants = {
  enter: (direction: number) => ({ opacity: 0, x: direction * 48, filter: `blur(${blur.soft}px)` }),
  center: { opacity: 1, x: 0, filter: "blur(0px)", transition: { x: SLIDE, opacity: { duration: .22, ease: enterEase }, filter: { duration: .24, ease: enterEase } } },
  exit: (direction: number) => ({ opacity: 0, x: direction * -36, filter: `blur(${blur.soft}px)`, transition: { x: SLIDE, opacity: { duration: .14, ease: standardEase }, filter: { duration: .14, ease: standardEase } } }),
};

/** Words roll one by one: a later date rises from below, an earlier one drops from above; words that stay the same hold still. */
function Rolling({ text, direction, reduced }: { text: string; direction: number; reduced: boolean }) {
  const words = text.split(/\s+/).filter(Boolean);
  return <span className={styles.rolling} aria-hidden="true">
    {words.map((word, index) => <span key={index} className={styles.word}>
      <AnimatePresence initial={false} mode="popLayout" custom={direction}>
        <motion.span key={word} className={styles.wordInner} custom={direction} variants={reduced ? fade : roll} initial="enter" animate="center" exit="exit">{word}</motion.span>
      </AnimatePresence>
    </span>)}
  </span>;
}

/** Remembers which way a range moved, so labels roll in time's direction. */
function useDirection(range: DateRange | null) {
  const time = range ? range.start.getTime() * 2 + range.end.getTime() : null;
  const [previous, setPrevious] = useState(time);
  const [direction, setDirection] = useState(1);
  if (time !== previous) { setPrevious(time); setDirection(time === null || previous === null || time >= previous ? 1 : -1); }
  return direction;
}

type Segment = { left: number; width: number } | null;
const cellIn = (date: Date, first: Date) => { const index = dayDiff(date, first); return { row: Math.floor(index / 7), col: index % 7 }; };

/** One week's slice of the highlight. It grows out of the edge the range arrives from, so hovering reads as stretching. */
function Bar({ row, segment, reduced }: { row: number; segment: Segment; reduced: boolean }) {
  const left = useMotionValue(segment?.left ?? 0), width = useMotionValue(segment?.width ?? 0), opacity = useMotionValue(segment ? 1 : 0);
  const leftPct = useTransform(left, value => `${value}%`), widthPct = useTransform(width, value => `${value}%`);
  const wasEmpty = useRef(!segment);
  useLayoutEffect(() => {
    if (!segment) { wasEmpty.current = true; animate(opacity, 0, { duration: reduced ? 0 : .14 }); return; }
    if (wasEmpty.current || reduced) { left.jump(segment.left); width.jump(segment.width); }
    else { animate(left, segment.left, STRETCH); animate(width, segment.width, STRETCH); }
    wasEmpty.current = false;
    animate(opacity, 1, { duration: reduced ? 0 : .16 });
  }, [left, opacity, reduced, segment, width]);
  return <motion.span className={styles.bar} style={{ left: leftPct, width: widthPct, opacity, top: `calc(${row} * var(--cell) + 3px)` }} />;
}

/** A solid end of the range. It glides from day to day and only fades when the end leaves this month. */
function Thumb({ cell, reduced }: { cell: { row: number; col: number } | null; reduced: boolean }) {
  const x = useMotionValue(cell?.col ?? 0), y = useMotionValue(cell?.row ?? 0), opacity = useMotionValue(cell ? 1 : 0), scale = useMotionValue(cell ? 1 : .8);
  const transform = useTransform(() => `translate(${x.get() * 100}%, ${y.get() * 100}%) scale(${scale.get()})`);
  const hidden = useRef(!cell);
  useLayoutEffect(() => {
    if (!cell) { hidden.current = true; animate(opacity, 0, { duration: reduced ? 0 : .12 }); animate(scale, .8, { duration: reduced ? 0 : .12 }); return; }
    if (hidden.current || reduced) { x.jump(cell.col); y.jump(cell.row); }
    else { animate(x, cell.col, GLIDE); animate(y, cell.row, GLIDE); }
    hidden.current = false;
    animate(opacity, 1, { duration: reduced ? 0 : .16 });
    animate(scale, 1, reduced ? { duration: 0 } : GLIDE);
  }, [cell, opacity, reduced, scale, x, y]);
  return <motion.span className={styles.thumb} style={{ transform, opacity }} />;
}

interface MonthProps {
  month: Date;
  range: DateRange | null;
  tabbable: string;
  today?: Date;
  minDate?: Date;
  maxDate?: Date;
  weekStartsOn: 0 | 1;
  reduced: boolean;
  formatters: { title: (month: Date) => string; day: (date: Date) => string; weekday: (date: Date) => string; weekdayLong: (date: Date) => string };
  onPick: (date: Date) => void;
  onHover: (date: Date) => void;
  onKey: (event: ReactKeyboardEvent<HTMLButtonElement>, date: Date) => void;
  onFocusDay: (date: Date) => void;
  idBase: string;
}

function Month({ month, range, tabbable, today, minDate, maxDate, weekStartsOn, reduced, formatters, onPick, onHover, onKey, onFocusDay, idBase }: MonthProps) {
  const first = useMemo(() => addDays(month, -((month.getDay() - weekStartsOn + 7) % 7)), [month, weekStartsOn]);
  const rows = useMemo(() => Array.from({ length: 6 }, (_, row) => Array.from({ length: 7 }, (_, col) => addDays(first, row * 7 + col))), [first]);
  const titleId = `${idBase}-${keyOf(month)}`;
  const inMonth = (date: Date) => monthDiff(date, month) === 0;

  const lo = range?.start, hi = range?.end;
  const loKey = lo ? keyOf(lo) : "", hiKey = hi ? keyOf(hi) : "";
  /** Each week's slice of the range, in percent of the row. Keyed by the range's days so bars only move when it does. */
  const segments = useMemo<Segment[]>(() => {
    if (!loKey || !hiKey) return rows.map(() => null);
    const start = fromKey(loKey), end = fromKey(hiKey);
    const unit = 100 / 7;
    const colOf = (date: Date) => dayDiff(date, first) % 7;
    return rows.map(row => {
      const days = row.filter(date => monthDiff(date, month) === 0);
      if (!days.length) return null;
      const rowFirst = days[0], rowLast = days[days.length - 1];
      if (!rowFirst || !rowLast) return null;
      const from = dayDiff(start, rowFirst) > 0 ? start : rowFirst, to = dayDiff(end, rowLast) < 0 ? end : rowLast;
      if (dayDiff(from, to) <= 0) { const a = colOf(from), b = colOf(to); return { left: a * unit, width: (b - a + 1) * unit }; }
      // The week sits wholly before or after the range: collapse at the edge the range would grow in from.
      if (dayDiff(rowLast, start) < 0) return { left: (colOf(rowLast) + 1) * unit, width: 0 };
      return { left: colOf(rowFirst) * unit, width: 0 };
    });
  }, [first, hiKey, loKey, month, rows]);
  const startCell = useMemo(() => loKey && monthDiff(fromKey(loKey), month) === 0 ? cellIn(fromKey(loKey), first) : null, [loKey, month, first]);
  const endCell = useMemo(() => hiKey && hiKey !== loKey && monthDiff(fromKey(hiKey), month) === 0 ? cellIn(fromKey(hiKey), first) : null, [hiKey, loKey, month, first]);

  return <div className={styles.month}>
    <p id={titleId} className={styles.monthTitle}>{formatters.title(month)}</p>
    {/* biome-ignore lint/a11y/useSemanticElements: A roving-focus day grid; only the active day button takes the tab stop. */}
    <div role="grid" aria-labelledby={titleId} className={styles.grid}>
      {/* biome-ignore lint/a11y/useSemanticElements lint/a11y/useFocusableInteractive: Grid rows of the roving-focus day grid. */}
      <div role="row" className={styles.weekdays}>
        {/* biome-ignore lint/a11y/useSemanticElements lint/a11y/useFocusableInteractive: Weekday headers of the day grid. */}
        {(rows[0] ?? []).map(date => <span key={date.getDay()} role="columnheader" aria-label={formatters.weekdayLong(date)}>{formatters.weekday(date)}</span>)}
      </div>
      <div className={styles.weeks}>
        <span className={styles.layer} aria-hidden="true">
          {segments.map((segment, row) => <Bar key={row} row={row} segment={segment} reduced={reduced} />)}
          <Thumb cell={startCell} reduced={reduced} />
          <Thumb cell={endCell} reduced={reduced} />
        </span>
        {/* biome-ignore lint/a11y/useSemanticElements lint/a11y/useFocusableInteractive: Grid rows of the roving-focus day grid. */}
        {rows.map((row, index) => <div key={index} role="row" className={styles.week}>
          {row.map(date => {
            // biome-ignore lint/a11y/useSemanticElements lint/a11y/useFocusableInteractive: An empty cell outside the month keeps the seven-column grid.
            if (!inMonth(date)) return <span key={keyOf(date)} role="gridcell" className={styles.blank} />;
            const key = keyOf(date);
            const disabled = Boolean((minDate && dayDiff(date, minDate) < 0) || (maxDate && dayDiff(date, maxDate) > 0));
            const inRange = Boolean(lo && hi && dayDiff(date, lo) >= 0 && dayDiff(date, hi) <= 0);
            const edge = sameDay(date, lo) || sameDay(date, hi);
            const isToday = sameDay(date, today);
            // biome-ignore lint/a11y/useSemanticElements lint/a11y/useFocusableInteractive: A day cell whose native button carries focus, activation and disabled state.
            return <span key={key} role="gridcell" aria-selected={inRange} className={styles.cell}>
              <button type="button" className={styles.day} data-date={key} data-edge={edge || undefined} data-range={inRange || undefined} data-today={isToday || undefined}
                tabIndex={key === tabbable ? 0 : -1} disabled={disabled} aria-current={isToday ? "date" : undefined}
                aria-label={formatters.day(date)}
                onClick={() => onPick(date)} onPointerEnter={() => { if (!disabled) onHover(date); }}
                onFocus={() => onFocusDay(date)} onKeyDown={event => onKey(event, date)}>
                <span>{date.getDate()}</span>
              </button>
            </span>;
          })}
        </div>)}
      </div>
    </div>
  </div>;
}

/** The visible months travel together; a leaving set turns inert so focus and queries only find the current one. */
const Months = forwardRef<HTMLDivElement, { children: ReactNode; direction: number; reduced: boolean }>(function Months({ children, direction, reduced }, ref) {
  const present = useIsPresent();
  return <motion.div ref={ref} className={styles.months} data-current={present || undefined} inert={!present || undefined} aria-hidden={present ? undefined : true} custom={direction}
    variants={reduced ? fade : slide} initial="enter" animate="center" exit="exit">{children}</motion.div>;
});

const PresentPanel = forwardRef<HTMLDivElement, HTMLMotionProps<"div">>(function PresentPanel(props, ref) {
  const present = useIsPresent();
  return <motion.div {...props} ref={ref} inert={!present || props.inert} aria-hidden={present ? props["aria-hidden"] : true} />;
});

export function DateRangePicker({ value, defaultValue = null, onChange, label: labelProp, placeholder: placeholderProp, presets, minDate, maxDate, weekStartsOn = 1, locale, months = "auto", boundary, className }: DateRangePickerProps) {
  const text = useMemo(() => dateRangeText(locale), [locale]);
  const label = labelProp ?? text.label;
  const placeholder = placeholderProp ?? text.placeholder;
  const reduced = useLiveReducedMotion();
  const today = useToday();
  const uid = useId();
  const [inner, setInner] = useState<DateRange | null>(defaultValue);
  const committed = value !== undefined ? value : inner;

  const [open, setOpen] = useState(false);
  const [compact, setCompact] = useState(false);
  const [panelWidth, setPanelWidth] = useState(0);
  const [view, setView] = useState<Date>(() => monthStart(committed?.end ?? new Date(2000, 0, 1)));
  const [direction, setDirection] = useState(1);
  const [draft, setDraft] = useState<DateRange | null>(committed);
  const [anchor, setAnchor] = useState<Date | null>(null);
  const [hover, setHover] = useState<Date | null>(null);
  const [focusKey, setFocusKey] = useState("");

  const formatters = useMemo(() => ({ title: text.monthTitle, day: text.day, weekday: text.weekdayShort, weekdayLong: text.weekdayLong }), [text]);
  const format = useCallback((range: DateRange | null) => !range ? placeholder : formatRangeShort(range, locale), [locale, placeholder]);
  const speak = useCallback((range: DateRange | null) => !range ? placeholder : formatRangeSpoken(range, locale), [locale, placeholder]);

  const count = compact ? 1 : 2;
  const visible = useMemo(() => Array.from({ length: count }, (_, index) => addMonths(view, index)), [count, view]);
  const shown = anchor ? ordered(anchor, hover ?? anchor) : draft;
  const presetRanges = today ? presets.map(preset => preset.range(today)) : [];
  const dayAllowed = (date: Date) => (!minDate || dayDiff(date, minDate) >= 0) && (!maxDate || dayDiff(date, maxDate) <= 0);
  const rangeAllowed = (range: DateRange | null) => !!range && dayDiff(range.start, range.end) <= 0 && dayAllowed(range.start) && dayAllowed(range.end);
  const applicable = anchor ? { start: anchor, end: anchor } : draft;
  const activePreset = !anchor ? presetRanges.findIndex(range => sameRange(range, draft)) : -1;
  const days = shown ? dayDiff(shown.end, shown.start) + 1 : 0;
  const committedDirection = useDirection(committed);
  const shownDirection = useDirection(shown);

  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<"trigger" | "day" | null>(null);

  /* ---------- One surface: the trigger's box springs to the panel's box and back ---------- */
  // Before the first measurement the surface simply fills the root and the root wraps the trigger, so server markup already looks right.
  const width = useMotionValue<number | string>("100%"), height = useMotionValue<number | string>("100%"), radius = useMotionValue(TRIGGER_RADIUS), x = useMotionValue(0), rootWidth = useMotionValue<number | string>("auto");
  const sizes = useRef<{ trigger: Size; panel: Size | null }>({ trigger: { w: 0, h: 0 }, panel: null });
  const live = useRef({ open: false, reduced: false, ready: false });
  const queued = useRef(false);
  const boundaryRef = useRef(boundary);
  useLayoutEffect(() => { boundaryRef.current = boundary; }, [boundary]);

  const bounds = useCallback(() => {
    const element = boundaryRef.current?.();
    const viewport = { left: 0, right: document.documentElement.clientWidth };
    if (!element) return viewport;
    const rect = element.getBoundingClientRect();
    return { left: Math.max(viewport.left, rect.left), right: Math.min(viewport.right, rect.right) };
  }, []);

  const update = useCallback(() => {
    queued.current = false;
    const { trigger, panel } = sizes.current, state = live.current;
    if (!trigger.w) return;
    const openPanel = state.open && panel ? panel : null;
    const target = openPanel ?? trigger;
    let offset = 0;
    if (openPanel && rootRef.current) {
      const rect = rootRef.current.getBoundingClientRect(), box = bounds();
      offset = Math.min(0, box.right - EDGE - (rect.left + openPanel.w));
      offset = Math.max(offset, box.left + EDGE - rect.left);
    }
    const r = openPanel ? PANEL_RADIUS : TRIGGER_RADIUS;
    if (!state.ready || state.reduced) {
      width.jump(target.w); height.jump(target.h); radius.jump(r); x.jump(offset); rootWidth.jump(trigger.w);
      state.ready = true;
      return;
    }
    const spring = openPanel ? GROW : state.open ? GROW : SHRINK;
    animate(width, target.w, spring); animate(height, target.h, spring); animate(radius, r, spring); animate(x, offset, spring);
    animate(rootWidth, trigger.w, motionTokens.spring.morph);
  }, [bounds, height, radius, rootWidth, width, x]);

  const schedule = useCallback(() => {
    if (queued.current) return;
    queued.current = true;
    queueMicrotask(update);
  }, [update]);

  useLayoutEffect(() => { live.current.open = open; live.current.reduced = reduced; if (!open) sizes.current.panel = null; schedule(); }, [open, reduced, schedule]);

  useLayoutEffect(() => {
    const node = triggerRef.current;
    if (!node) return;
    const read = () => { sizes.current.trigger = { w: node.offsetWidth, h: node.offsetHeight }; schedule(); };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(node);
    return () => observer.disconnect();
  }, [schedule]);

  useLayoutEffect(() => {
    const node = panelRef.current;
    if (!open || !node) return;
    const read = () => { sizes.current.panel = { w: node.offsetWidth, h: node.offsetHeight }; schedule(); };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(node);
    return () => observer.disconnect();
  }, [open, schedule]);

  // Without an observer, re-read after React changes the compact layout, content or trigger label.
  useLayoutEffect(() => {
    if (typeof ResizeObserver !== "undefined") return;
    const trigger = triggerRef.current, panel = panelRef.current;
    if (trigger) sizes.current.trigger = { w: trigger.offsetWidth, h: trigger.offsetHeight };
    if (open && panel) sizes.current.panel = { w: panel.offsetWidth, h: panel.offsetHeight };
    schedule();
  });

  // On a short screen (a phone, a trigger low on the page) the panel can open below the fold, with Apply out of reach.
  // Once it has its size, scroll just enough to bring its bottom into view, never past its top. After closing, the
  // trigger comes back into view if that scroll left it off screen.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const node = panelRef.current;
      if (!node) return;
      const rect = node.getBoundingClientRect();
      const overflow = rect.bottom - (window.innerHeight - EDGE);
      if (overflow <= 0) return;
      window.scrollBy({ top: Math.min(overflow, Math.max(0, rect.top - EDGE)), behavior: reduced ? "instant" : "smooth" });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, reduced]);
  useEffect(() => {
    if (open) return;
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > window.innerHeight) trigger.scrollIntoView({ block: "center", behavior: reduced ? "instant" : "smooth" });
  }, [open, reduced]);

  /* ---------- Layout: two months when there is room, one compact month otherwise ---------- */
  const measureLayout = useCallback(() => {
    const box = bounds();
    const available = Math.max(0, box.right - box.left - EDGE * 2);
    const single = months === 1 || (months === "auto" && available < WIDE_MIN);
    return { single, width: Math.min(352, available) };
  }, [bounds, months]);

  useEffect(() => {
    if (!open) return;
    const onResize = () => { const next = measureLayout(); setCompact(next.single); setPanelWidth(next.width); schedule(); };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [measureLayout, open, schedule]);

  const viewFor = (range: DateRange | null, single: boolean, fallback: Date) => {
    const end = monthStart(range?.end ?? fallback);
    return single ? end : addMonths(end, -1);
  };

  const openPanel = () => {
    if (!today) return;
    const layout = measureLayout();
    setCompact(layout.single);
    setPanelWidth(layout.width);
    setDraft(committed);
    setAnchor(null);
    setHover(null);
    const firstChoice = clampDate(committed?.start ?? today, minDate, maxDate);
    const lastChoice = clampDate(committed?.end ?? today, minDate, maxDate);
    const nextView = viewFor(committed ? { start: firstChoice, end: lastChoice } : null, layout.single, lastChoice);
    const lastVisible = addMonths(nextView, layout.single ? 0 : 1);
    const onScreen = monthDiff(firstChoice, nextView) < 0 ? nextView : monthDiff(firstChoice, lastVisible) > 0 ? monthEnd(lastVisible) : firstChoice;
    setView(nextView);
    setDirection(0);
    setFocusKey(keyOf(clampDate(onScreen, minDate, maxDate)));
    pendingFocus.current = "day";
    setOpen(true);
  };

  const close = useCallback((focus: boolean) => {
    if (focus) pendingFocus.current = "trigger";
    setDirection(0);
    setOpen(false);
    setAnchor(null);
    setHover(null);
  }, []);

  const apply = () => {
    const next = anchor ? { start: anchor, end: anchor } : draft;
    if (!next || !rangeAllowed(next)) return;
    if (value === undefined) setInner(next);
    onChange?.(next);
    close(true);
  };

  /* ---------- Focus management ---------- */
  // biome-ignore lint/correctness/useExhaustiveDependencies: A new month view or layout replaces the day buttons, so focus is placed again after the DOM changes.
  useLayoutEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    if (target === "trigger" && !open) { pendingFocus.current = null; triggerRef.current?.focus({ preventScroll: true }); return; }
    if (target === "day" && open) {
      const node = panelRef.current?.querySelector<HTMLButtonElement>(`[data-current] [data-date="${focusKey}"]`);
      if (node) { pendingFocus.current = null; node.focus({ preventScroll: true }); }
    }
  }, [focusKey, open, view, compact]);

  useEffect(() => {
    if (!open) return;
    const down = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) close(false); };
    document.addEventListener("pointerdown", down);
    return () => document.removeEventListener("pointerdown", down);
  }, [close, open]);

  const onRootKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); close(true); }
  };
  const onRootBlur = (event: ReactFocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget as Node | null;
    if (open && next && !event.currentTarget.contains(next)) close(false);
  };

  /* ---------- Month navigation and picking ---------- */
  const goTo = (next: Date) => {
    const delta = monthDiff(next, view);
    if (!delta) return;
    setDirection(Math.sign(delta));
    setView(next);
  };

  /** Keeps a range on screen: nothing moves when it already fits, otherwise its last month lands on the right. */
  const reveal = (range: DateRange) => {
    const first = view, last = addMonths(view, count - 1);
    if (monthDiff(range.start, first) >= 0 && monthDiff(range.end, last) <= 0) return;
    goTo(viewFor(range, compact, range.end));
  };

  const pick = (date: Date) => {
    if (!dayAllowed(date)) return;
    if (anchor && !dayAllowed(anchor)) { setAnchor(date); setHover(date); setFocusKey(keyOf(date)); return; }
    setFocusKey(keyOf(date));
    if (!anchor) { setAnchor(date); setHover(date); return; }
    setDraft(ordered(anchor, date));
    setAnchor(null);
    setHover(null);
  };

  const choosePreset = (preset: DateRangePreset) => {
    if (!today) return;
    const range = preset.range(today);
    if (!rangeAllowed(range)) return;
    setDraft(range);
    setAnchor(null);
    setHover(null);
    setFocusKey(keyOf(range.start));
    reveal(range);
  };

  const onDayKey = (event: ReactKeyboardEvent<HTMLButtonElement>, date: Date) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || (event.shiftKey && event.key !== "PageUp" && event.key !== "PageDown") || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    const weekday = (date.getDay() - weekStartsOn + 7) % 7;
    const moves: Record<string, () => Date> = {
      ArrowLeft: () => addDays(date, -1), ArrowRight: () => addDays(date, 1), ArrowUp: () => addDays(date, -7), ArrowDown: () => addDays(date, 7),
      Home: () => addDays(date, -weekday), End: () => addDays(date, 6 - weekday),
      PageUp: () => shiftMonths(date, event.shiftKey ? -12 : -1), PageDown: () => shiftMonths(date, event.shiftKey ? 12 : 1),
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    const next = clampDate(move(), minDate, maxDate);
    setFocusKey(keyOf(next));
    if (anchor) setHover(next);
    pendingFocus.current = "day";
    const first = view, last = addMonths(view, count - 1);
    if (monthDiff(next, first) < 0) goTo(monthStart(next));
    else if (monthDiff(next, last) > 0) goTo(addMonths(monthStart(next), -(count - 1)));
  };

  const onRailKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    const keys = compact ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
    if (!keys.includes(event.key)) return;
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-preset]:not(:disabled)"));
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    event.preventDefault();
    buttons[(at + (event.key === keys[1] ? 1 : -1) + buttons.length) % buttons.length]?.focus();
  };

  const preserveDayFocus = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!panelRef.current?.querySelector("[data-current]")?.contains(document.activeElement)) return;
    if (event.pointerType === "mouse") event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
  };

  /** The day that owns the tab stop: the focused day when it is on screen, else the first visible day of the range, else the 1st. */
  const tabbable = (() => {
    const onScreen = (date: Date) => visible.some(month => monthDiff(date, month) === 0);
    if (focusKey && onScreen(fromKey(focusKey)) && dayAllowed(fromKey(focusKey))) return focusKey;
    if (shown && onScreen(shown.start) && dayAllowed(shown.start)) return keyOf(shown.start);
    const first = clampDate(visible[0] ?? view, minDate, maxDate);
    return onScreen(first) && dayAllowed(first) ? keyOf(first) : "";
  })();

  /* ---------- Preset highlight glides between presets ---------- */
  const gx = useMotionValue(0), gy = useMotionValue(0), gw = useMotionValue(0), gh = useMotionValue(0), go = useMotionValue(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Opening mounts a fresh rail whose preset positions must be measured.
  useLayoutEffect(() => {
    const rail = railRef.current;
    const node = activePreset < 0 ? null : rail?.querySelector<HTMLElement>(`[data-preset="${activePreset}"]`);
    if (!rail || !node) { animate(go, 0, { duration: reduced ? 0 : .14 }); return; }
    const place = [node.offsetLeft, node.offsetTop, node.offsetWidth, node.offsetHeight] as const;
    if (go.get() < .05 || reduced) { gx.jump(place[0]); gy.jump(place[1]); gw.jump(place[2]); gh.jump(place[3]); }
    else { animate(gx, place[0], GLIDE); animate(gy, place[1], GLIDE); animate(gw, place[2], GLIDE); animate(gh, place[3], GLIDE); }
    animate(go, 1, { duration: reduced ? 0 : .16 });
    if (compact && (node.offsetLeft < rail.scrollLeft || node.offsetLeft + node.offsetWidth > rail.scrollLeft + rail.clientWidth)) {
      rail.scrollTo({ left: node.offsetLeft - 12, behavior: reduced ? "auto" : "smooth" });
    }
  }, [activePreset, compact, go, gh, gw, gx, gy, open, reduced]);

  /* ---------- Copy ---------- */
  const committedText = format(committed);
  const shownText = shown ? format(shown) : text.noDates;
  const countText = shown ? text.days(days) : "";
  const status = !open ? "" : anchor ? text.startChosen(formatRangeSpoken({ start: anchor, end: anchor }, locale)) : shown ? `${speak(shown)}, ${countText}` : "";
  const layoutId = reduced ? undefined : `${uid}-value`;

  const cellSize = compact && panelWidth ? Math.max(32, Math.min(42, Math.floor((panelWidth - 24) / 7))) : WIDE_CELL;

  const quiet = open ? (reduced ? { opacity: 0 } : { opacity: 0, filter: `blur(${blur.subtle}px)` }) : { opacity: 1, filter: "blur(0px)" };
  const quietTransition = open ? { duration: .12, ease: standardEase } : { duration: .22, ease: enterEase, delay: reduced ? 0 : .1 };

  return <motion.div ref={rootRef} className={[styles.root, className].filter(Boolean).join(" ")} style={{ width: rootWidth }} data-open={open || undefined} onKeyDown={onRootKey} onBlur={onRootBlur}>
    {/* The trigger stays in place under the panel. Its icons fade, while the value itself flies to the panel footer and back. */}
    <button ref={triggerRef} type="button" className={styles.trigger} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? `${uid}-panel` : undefined}
      aria-describedby={`${uid}-spoken`} disabled={!today} inert={open || undefined} onClick={openPanel}>
      {/* Named from content with the visible short range (WCAG 2.5.3); the animated copy is decorative. */}
      <span className={styles.srOnly}>{`${label}: ${committedText}`}</span>
      <motion.span className={styles.triggerIcon} initial={false} animate={quiet} transition={quietTransition}><CalendarDays size={16} strokeWidth={1.75} aria-hidden="true" /></motion.span>
      {open || !layoutId
        ? <motion.span key="resting" className={styles.value} data-empty={!committed || undefined} initial={false} animate={open ? { opacity: 0 } : { opacity: 1 }} transition={quietTransition}>
          <Rolling text={committedText} direction={committedDirection} reduced={reduced} />
        </motion.span>
        : <motion.span key="shared" layoutId={layoutId} layout="position" className={styles.value} data-empty={!committed || undefined} transition={SHRINK}>
          <Rolling text={committedText} direction={committedDirection} reduced={reduced} />
        </motion.span>}
      <motion.span className={styles.chevron} initial={false} animate={quiet} transition={quietTransition}><ChevronDown size={16} strokeWidth={1.75} aria-hidden="true" /></motion.span>
    </button>

    {/* The full range, read as the trigger's description. */}
    <span id={`${uid}-spoken`} className={styles.srOnly} hidden>{speak(committed)}</span>

    <motion.div className={styles.surface} style={{ width, height, borderRadius: radius, x }}>
      <AnimatePresence>
        {open && today && <PresentPanel key="panel" ref={panelRef} id={`${uid}-panel`} className={styles.panel} role="dialog" aria-label={label} data-compact={compact || undefined}
          style={{ "--cell": `${cellSize}px`, width: compact && panelWidth ? panelWidth : undefined } as CSSProperties} exit={{ opacity: 1, transition: { duration: .14 } }}>
          <motion.div className={styles.body} variants={reduced ? faceFade : faceIn} initial="hidden" animate="shown" exit="gone">
            {/* biome-ignore lint/a11y/useSemanticElements: A named group of preset buttons, not form fields. */}
            {presets.length > 0 && <div ref={railRef} className={styles.rail} role="group" aria-label={text.presets} onKeyDown={onRailKey}>
              <motion.span className={styles.railHighlight} style={{ x: gx, y: gy, width: gw, height: gh, opacity: go }} aria-hidden="true" />
              {presets.map((preset, index) => <button key={preset.label} type="button" className={styles.preset} data-preset={index} aria-pressed={index === activePreset} disabled={!rangeAllowed(presetRanges[index] ?? null)} onPointerDown={preserveDayFocus}
                onClick={() => choosePreset(preset)}>{preset.label}</button>)}
            </div>}

            <div className={styles.calendars} onPointerLeave={() => { if (anchor) setHover(null); }}>
              <button type="button" className={styles.navButton} data-side="prev" aria-label={text.previousMonth} onPointerDown={preserveDayFocus} onClick={() => goTo(addMonths(view, -1))}
                disabled={Boolean(minDate && monthDiff(view, minDate) <= 0)}><ChevronLeft size={16} strokeWidth={1.75} aria-hidden="true" /></button>
              <button type="button" className={styles.navButton} data-side="next" aria-label={text.nextMonth} onPointerDown={preserveDayFocus} onClick={() => goTo(addMonths(view, 1))}
                disabled={Boolean(maxDate && monthDiff(addMonths(view, count - 1), maxDate) >= 0)}><ChevronRight size={16} strokeWidth={1.75} aria-hidden="true" /></button>
              <div className={styles.viewport}>
                <AnimatePresence initial={false} mode="popLayout" custom={direction}>
                  <Months key={`${keyOf(view)}-${count}`} direction={direction} reduced={reduced}>
                    {visible.map(month => <Month key={keyOf(month)} month={month} range={shown} tabbable={tabbable} today={today} minDate={minDate} maxDate={maxDate}
                      weekStartsOn={weekStartsOn} reduced={reduced} formatters={formatters} idBase={uid}
                      onPick={pick} onHover={date => { if (anchor) setHover(date); }} onKey={onDayKey} onFocusDay={date => setFocusKey(keyOf(date))} />)}
                  </Months>
                </AnimatePresence>
              </div>
            </div>
          </motion.div>

          <div className={styles.footer}>
            <div className={styles.summary}>
              <motion.span layoutId={layoutId} layout={layoutId ? "position" : undefined} className={styles.summaryValue} transition={GROW}
                variants={layoutId ? undefined : faceFade} initial={layoutId ? undefined : "hidden"} animate={layoutId ? undefined : "shown"} exit={layoutId ? undefined : "gone"}>
                <Rolling text={shownText} direction={shownDirection} reduced={reduced} />
              </motion.span>
              <motion.span className={styles.summaryCount} variants={reduced ? faceFade : faceIn} initial="hidden" animate="shown" exit="gone">
                {countText && <Rolling text={anchor && sameDay(anchor, hover) ? text.pickEnd : countText} direction={shownDirection} reduced={reduced} />}
              </motion.span>
            </div>
            <motion.div className={styles.actions} variants={reduced ? faceFade : faceIn} initial="hidden" animate="shown" exit="gone">
              <button type="button" className={styles.ghost} onClick={() => close(true)}>{text.cancel}</button>
              <button type="button" className={styles.primary} onClick={apply} disabled={!rangeAllowed(applicable)}>{text.apply}</button>
            </motion.div>
          </div>
          <p className={styles.srOnly} aria-live="polite">{status}</p>
        </PresentPanel>}
      </AnimatePresence>
    </motion.div>
  </motion.div>;
}

export default DateRangePicker;
