import { CalendarDays, ChevronDown } from "lucide-react";
import type { Variants } from "motion/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { ButtonHTMLAttributes, FocusEvent, KeyboardEvent } from "react";
import { useEffect, useId, useRef, useState } from "react";
import { Calendar } from "../calendar/calendar";
import { motionTokens } from "../lib/motion-tokens";
import styles from "./date-picker.module.css";

export interface DatePickerProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "value" | "onChange"> {
  label: string;
  value?: Date;
  onChange?: (date: Date) => void;
  description?: string;
  placeholder?: string;
  minDate?: Date;
  maxDate?: Date;
  /** Civil date used for the current-day marker when the service timezone differs. */
  today?: Date;
  locale?: string;
  formatValue?: (date: Date) => string;
  calendarLabel?: string;
}

const monthStart = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth(), 1);
const { spring, duration, ease, blur } = motionTokens;
const instant = { duration: duration.instant };
/** Each part of the date rolls with time: a later date rises from below, an earlier one drops from above. */
const valueRoll: Variants = {
  enter: (direction: number) => ({
    opacity: 0,
    y: `${direction * 0.35}em`,
    filter: `blur(${blur.soft}px)`,
  }),
  center: {
    opacity: 1,
    y: 0,
    filter: "blur(0px)",
    transition: { duration: duration.standard, ease: [...ease.enter] },
  },
  exit: (direction: number) => ({
    opacity: 0,
    y: `${direction * -0.3}em`,
    filter: `blur(${blur.subtle}px)`,
    transition: { duration: 0.14, ease: [...ease.standard] },
  }),
};
const valueFade: Variants = {
  enter: { opacity: 0 },
  center: { opacity: 1, y: 0, filter: "blur(0px)", transition: instant },
  exit: { opacity: 0, transition: instant },
};

export function DatePicker({
  label,
  value,
  onChange,
  description,
  placeholder = "",
  minDate,
  maxDate,
  today,
  locale = "es",
  formatValue = (date) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(date),
  calendarLabel,
  id,
  className,
  disabled,
  ...buttonProps
}: DatePickerProps) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const labelId = `${controlId}-label`;
  const valueId = `${controlId}-value`;
  const hintId = description ? `${controlId}-description` : undefined;
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(monthStart(value ?? today ?? new Date()));
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number | undefined>(undefined);
  const reduce = useReducedMotion() ?? false;
  const time = value?.getTime() ?? null;
  const [previousTime, setPreviousTime] = useState(time);
  const [direction, setDirection] = useState(1);
  if (previousTime !== time) {
    setPreviousTime(time);
    setDirection(
      time === null || previousTime === null || time >= previousTime ? 1 : -1,
    );
  }
  const shown = value ? formatValue(value) : placeholder;

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        window.clearTimeout(closeTimer.current);
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.clearTimeout(closeTimer.current);
    };
  }, []);

  useEffect(() => {
    if (open)
      popoverRef.current
        ?.querySelector<HTMLButtonElement>(
          '[data-present] [data-date][tabindex="0"]',
        )
        ?.focus({ preventScroll: true });
  }, [open]);

  const close = () => {
    window.clearTimeout(closeTimer.current);
    if (popoverRef.current?.contains(document.activeElement))
      triggerRef.current?.focus();
    setOpen(false);
  };
  const show = () => {
    window.clearTimeout(closeTimer.current);
    setMonth(monthStart(value ?? today ?? new Date()));
    setOpen(true);
  };
  const selectDate = (date: Date | undefined) => {
    if (!date) return;
    onChange?.(date);
    window.clearTimeout(closeTimer.current);
    if (reduce) close();
    else closeTimer.current = window.setTimeout(close, 220);
  };
  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (
      (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") &&
      !open
    ) {
      event.preventDefault();
      show();
    }
    if (event.key === "Escape") close();
  };
  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget as Node | null;
    if (open && next && !rootRef.current?.contains(next)) {
      window.clearTimeout(closeTimer.current);
      setOpen(false);
    }
  };

  return (
    <div
      className={[styles.field, className].filter(Boolean).join(" ")}
      ref={rootRef}
      onBlur={onBlur}
    >
      <label className={styles.label} htmlFor={controlId} id={labelId}>
        {label}
      </label>
      <div className={styles.anchor}>
        <button
          {...buttonProps}
          ref={triggerRef}
          id={controlId}
          type="button"
          disabled={disabled}
          aria-labelledby={`${labelId} ${valueId}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-describedby={hintId}
          className={styles.trigger}
          onClick={() => (open ? close() : show())}
          onKeyDown={onTriggerKeyDown}
        >
          <CalendarDays size={16} strokeWidth={1.75} aria-hidden="true" />
          <span className={styles.srOnly} id={valueId}>
            {shown}
          </span>
          <span className={styles.valueText} aria-hidden="true">
            <AnimatePresence mode="popLayout" initial={false} custom={direction}>
              <motion.span
                key={time ?? "placeholder"}
                className={value ? styles.value : styles.placeholder}
                custom={direction}
                variants={reduce ? valueFade : valueRoll}
                initial="enter"
                animate="center"
                exit="exit"
              >
                {shown}
              </motion.span>
            </AnimatePresence>
          </span>
          <ChevronDown
            className={styles.chevron}
            size={16}
            strokeWidth={1.75}
            aria-hidden="true"
          />
        </button>
        <AnimatePresence>
          {open && (
            <motion.div
              ref={popoverRef}
              className={styles.popover}
              role="dialog"
              aria-label={calendarLabel ?? label}
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
                  ? instant
                  : {
                      ...spring.snappy,
                      opacity: { duration: duration.fast, ease: [...ease.enter] },
                    },
              }}
              exit={{
                opacity: 0,
                ...(reduce ? {} : { y: -6, scale: 0.97 }),
                transition: { duration: 0.14, ease: [...ease.standard] },
              }}
            >
              <Calendar
                value={value}
                onChange={selectDate}
                month={month}
                onMonthChange={setMonth}
                minDate={minDate}
                maxDate={maxDate}
                today={today}
                locale={locale}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      {description && (
        <span id={hintId} className={styles.description}>
          {description}
        </span>
      )}
    </div>
  );
}
