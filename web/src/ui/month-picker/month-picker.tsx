import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { FocusEvent, KeyboardEvent, ReactNode } from "react";
import { useEffect, useId, useRef, useState } from "react";
import styles from "../date-picker/date-picker.module.css";
import {
  anchorStyle,
  topLayerProps,
  useAnchorName,
  useTopLayerRef,
} from "../lib/anchored-popover";
import { FieldMessage } from "../lib/field-message";
import { dateTimeFormat } from "../lib/intl-cache";
import { motionTokens } from "../lib/motion-tokens";
import own from "./month-picker.module.css";

/** A civil month as `YYYY-MM`, the format of a native month input. */
export type MonthValue = string;
const key = (year: number, month: number) =>
  `${year}-${String(month + 1).padStart(2, "0")}`;
const parse = (value?: string) => {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(value ?? "");
  return match ? { year: Number(match[1]), month: Number(match[2]) - 1 } : null;
};

export interface MonthPickerProps {
  label: string;
  value?: MonthValue;
  onChange?: (value: MonthValue) => void;
  description?: string;
  placeholder?: string;
  /** Earliest and latest selectable months, as `YYYY-MM`. */
  min?: MonthValue;
  max?: MonthValue;
  locale?: string;
  labels: { previousYear: string; nextYear: string };
  error?: string;
  disabled?: boolean;
  id?: string;
  /** Rendered beside the trigger, such as a form's hidden value. */
  children?: ReactNode;
}

/**
 * A month chooser that shares the date picker's field and floating panel: a year header with its own steps and the
 * twelve months as a grid. Arrow keys move between months, crossing into the next or previous year.
 */
export function MonthPicker({
  label,
  value,
  onChange,
  description,
  placeholder = "",
  min,
  max,
  locale = "es",
  labels,
  error,
  disabled,
  id,
  children,
}: MonthPickerProps) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const labelId = `${controlId}-label`;
  const valueId = `${controlId}-value`;
  const hintId = description ? `${controlId}-description` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const selected = parse(value);
  const [open, setOpen] = useState(false);
  const [year, setYear] = useState(
    () => selected?.year ?? new Date().getFullYear(),
  );
  const [focus, setFocus] = useState(selected?.month ?? new Date().getMonth());
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const panelRef = useTopLayerRef(popoverRef, triggerRef);
  const anchor = useAnchorName();
  const reduce = useReducedMotion() ?? false;
  const long = dateTimeFormat(locale, { month: "long", year: "numeric" });
  const short = dateTimeFormat(locale, { month: "short" });
  const shown = selected
    ? long.format(new Date(selected.year, selected.month, 1))
    : placeholder;
  const outside = (y: number, m: number) =>
    (min !== undefined && key(y, m) < min) ||
    (max !== undefined && key(y, m) > max);
  const minYear = parse(min)?.year;
  const maxYear = parse(max)?.year;

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, []);
  useEffect(() => {
    if (open)
      popoverRef.current
        ?.querySelector<HTMLButtonElement>('[tabindex="0"]')
        ?.focus({ preventScroll: true });
  }, [open]);

  const close = () => {
    if (popoverRef.current?.contains(document.activeElement))
      triggerRef.current?.focus();
    setOpen(false);
  };
  const show = () => {
    const now = new Date();
    setYear(selected?.year ?? now.getFullYear());
    setFocus(selected?.month ?? now.getMonth());
    setOpen(true);
  };
  const choose = (m: number) => {
    if (outside(year, m)) return;
    onChange?.(key(year, m));
    close();
  };
  const move = (delta: number) => {
    const index = year * 12 + focus + delta;
    const nextYear = Math.floor(index / 12);
    const nextMonth = index - nextYear * 12;
    if (outside(nextYear, nextMonth)) return;
    setYear(nextYear);
    setFocus(nextMonth);
    // The grid re-renders with the new roving tab stop before it is focused.
    requestAnimationFrame(() =>
      popoverRef.current
        ?.querySelector<HTMLButtonElement>(`[data-month="${key(nextYear, nextMonth)}"]`)
        ?.focus({ preventScroll: true }),
    );
  };
  const onGridKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const steps: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -4,
      ArrowDown: 4,
      PageUp: -12,
      PageDown: 12,
    };
    const step = steps[event.key];
    if (step === undefined) return;
    event.preventDefault();
    move(step);
  };
  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget as Node | null;
    if (open && next && !rootRef.current?.contains(next)) setOpen(false);
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: This named interaction group is not a form fieldset.
    <div
      className={styles.field}
      ref={rootRef}
      role="group"
      aria-labelledby={labelId}
      onBlur={onBlur}
    >
      <label className={styles.label} htmlFor={controlId} id={labelId}>
        {label}
      </label>
      <div className={styles.anchor}>
        <button
          ref={triggerRef}
          id={controlId}
          type="button"
          disabled={disabled}
          aria-labelledby={`${labelId} ${valueId}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-describedby={[hintId, errorId].filter(Boolean).join(" ") || undefined}
          aria-invalid={error ? true : undefined}
          className={styles.trigger}
          style={anchorStyle(anchor)}
          onClick={() => (open ? close() : show())}
          onKeyDown={(event) => {
            if (
              !open &&
              (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ")
            ) {
              event.preventDefault();
              show();
            }
            if (event.key === "Escape") close();
          }}
        >
          <CalendarDays size={16} strokeWidth={1.75} aria-hidden="true" />
          <span className={styles.srOnly} id={valueId}>
            {shown}
          </span>
          <span className={styles.valueText} aria-hidden="true">
            <span className={selected ? styles.value : styles.placeholder}>
              {shown}
            </span>
          </span>
          <ChevronDown
            className={styles.chevron}
            size={16}
            strokeWidth={1.75}
            aria-hidden="true"
          />
        </button>
        {children}
        <AnimatePresence>
          {open && (
            <motion.div
              {...topLayerProps(anchor)}
              ref={panelRef}
              className={`${styles.popover} ${own.panel}`}
              role="dialog"
              aria-label={label}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.stopPropagation();
                  close();
                }
              }}
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: -8, scale: 0.95 }}
              animate={{
                opacity: 1,
                y: 0,
                scale: 1,
                transition: reduce
                  ? { duration: motionTokens.duration.instant }
                  : {
                      ...motionTokens.spring.snappy,
                      opacity: {
                        duration: motionTokens.duration.fast,
                        ease: [...motionTokens.ease.enter],
                      },
                    },
              }}
              exit={{
                opacity: 0,
                ...(reduce ? {} : { y: -6, scale: 0.97 }),
                transition: { duration: 0.14, ease: [...motionTokens.ease.standard] },
              }}
            >
              <div className={own.header}>
                <span className={own.year} aria-live="polite">
                  {year}
                </span>
                <button
                  type="button"
                  className={own.step}
                  aria-label={labels.previousYear}
                  aria-disabled={
                    minYear !== undefined && year <= minYear ? true : undefined
                  }
                  onClick={() => {
                    if (minYear === undefined || year > minYear)
                      setYear(year - 1);
                  }}
                >
                  <ChevronLeft size={16} strokeWidth={1.75} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className={own.step}
                  aria-label={labels.nextYear}
                  aria-disabled={
                    maxYear !== undefined && year >= maxYear ? true : undefined
                  }
                  onClick={() => {
                    if (maxYear === undefined || year < maxYear)
                      setYear(year + 1);
                  }}
                >
                  <ChevronRight size={16} strokeWidth={1.75} aria-hidden="true" />
                </button>
              </div>
              {/* biome-ignore lint/a11y/noStaticElementInteractions: Arrow keys move the roving focus between the month buttons. */}
              <div className={own.grid} onKeyDown={onGridKeyDown}>
                {Array.from({ length: 12 }, (_, m) => {
                  const date = new Date(year, m, 1);
                  const current = selected?.year === year && selected.month === m;
                  return (
                    <button
                      key={key(year, m)}
                      type="button"
                      className={own.month}
                      data-month={key(year, m)}
                      aria-label={long.format(date)}
                      aria-pressed={current}
                      disabled={outside(year, m)}
                      tabIndex={m === focus ? 0 : -1}
                      onFocus={() => setFocus(m)}
                      onClick={() => choose(m)}
                    >
                      {short.format(date).replace(".", "")}
                    </button>
                  );
                })}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      {description && (
        <span id={hintId} className={styles.description}>
          {description}
        </span>
      )}
      <FieldMessage id={errorId} text={error} className={styles.error} />
    </div>
  );
}
