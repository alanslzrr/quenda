"use client";

import { forwardRef, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, animate, motion, useIsPresent, useMotionValue, type AnimationPlaybackControls, type HTMLMotionProps, type Variants } from "motion/react";
import { ArrowDownRight, ArrowRight, ArrowUpRight } from "lucide-react";
import { pickText } from "../lib/locale-text";
import { motionTokens } from "../lib/motion-tokens";
import { useLiveReducedMotion } from "../lib/use-live-reduced-motion";
import { AnimatedCounter } from "../animated-counter/animated-counter";
import styles from "./metric-card.module.css";

/** A change against a reference such as the previous period. The arrow and the text carry the meaning; the tone only reinforces it. */
export interface MetricComparison {
  /** Caller-written copy, such as "+12 % fronte ao período anterior". */
  text: string;
  direction: "up" | "down" | "flat";
  /** Whether the change is good, bad or neither. Defaults to neutral. */
  tone?: "positive" | "negative" | "neutral";
}

export interface MetricCardProps {
  label: string;
  /** A number animates; a string, such as "No aplicable", is shown as is. */
  value: number | string;
  /** Number formatting, and the language of the spoken comparison direction (Galician gl or Spanish es; Spanish when omitted). */
  locale?: string;
  decimals?: number;
  suffix?: string;
  context: string;
  /** A short signed chip beside the label, such as "+4". */
  change?: string;
  /** A line under the value comparing it with a reference period. */
  comparison?: MetricComparison;
}

/** Copy that holds a number enters from the side it moved toward: a larger value rises from below, a smaller one drops from above. */
const rise: Variants = { hidden: (direction: number) => ({ opacity: 0, y: `${.3 * direction}em`, filter: `blur(${motionTokens.blur.soft}px)` }), shown: { opacity: 1, y: 0, filter: "blur(0px)", transition: { duration: motionTokens.duration.standard, ease: [...motionTokens.ease.enter] } }, gone: (direction: number) => ({ opacity: 0, y: `${-.3 * direction}em`, filter: `blur(${motionTokens.blur.subtle}px)`, transition: { duration: motionTokens.duration.fast, ease: [...motionTokens.ease.standard] } }) };
const fade: Variants = { hidden: { opacity: 0, y: 0, filter: "blur(0px)" }, shown: { opacity: 1, y: 0, filter: "blur(0px)", transition: { duration: motionTokens.duration.instant } }, gone: { opacity: 0, y: 0, filter: "blur(0px)", transition: { duration: motionTokens.duration.instant } } };
const amountIn = (text: string) => Number(text.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/)?.[0] ?? NaN);
const arrows = { up: ArrowUpRight, down: ArrowDownRight, flat: ArrowRight } as const;
/** Spoken before the comparison text, so its direction never depends on the arrow alone. */
const directionText = (locale: string, direction: MetricComparison["direction"]) =>
  pickText(locale, {
    gl: { up: "Sube", down: "Baixa", flat: "Sen cambios" },
    es: { up: "Sube", down: "Baja", flat: "Sin cambios" },
    en: { up: "Up", down: "Down", flat: "No change" },
  })[direction];

// Retained exit frames must not duplicate the current accessible copy.
const OutgoingText = forwardRef<HTMLSpanElement, HTMLMotionProps<"span">>(function OutgoingText(props, ref) {
  const present = useIsPresent();
  return <motion.span {...props} ref={ref} aria-hidden={!present || undefined} />;
});
const ChangeChip = forwardRef<HTMLElement, HTMLMotionProps<"small">>(function ChangeChip(props, ref) {
  const present = useIsPresent();
  return <motion.small {...props} ref={ref} aria-hidden={!present || undefined} />;
});

/** New copy rises in while the old copy leaves; `morph` springs the wrapper to the new text's width instead of letting it snap. */
function Swap({ text, morph = false, block = false }: { text: string; morph?: boolean; block?: boolean }) {
  const reduceMotion = useLiveReducedMotion();
  const sizer = useRef<HTMLSpanElement>(null);
  const width = useMotionValue<number | "auto">("auto");
  const [shown, setShown] = useState({ text, direction: 1 });
  if (shown.text !== text) setShown({ text, direction: amountIn(text) < amountIn(shown.text) ? -1 : 1 });
  useLayoutEffect(() => { if (reduceMotion) width.jump("auto"); }, [reduceMotion, width]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Changing morph replaces the measured element.
  useEffect(() => {
    const node = sizer.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    let measured: string | null = null;
    let controls: AnimationPlaybackControls | undefined;
    // Layout size, not the transformed rect, so a scaling parent never leaves the text clipped. Only a new text springs; font loads jump.
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const next = entry.borderBoxSize?.[0]?.inlineSize ?? node.offsetWidth;
      controls?.stop();
      if (next && measured !== null && measured !== node.textContent && !reduceMotion) controls = animate(width, next, motionTokens.spring.morph);
      else width.jump(next || "auto");
      measured = next ? node.textContent : null;
    });
    observer.observe(node);
    return () => { observer.disconnect(); controls?.stop(); };
  }, [morph, reduceMotion, width]);
  return <motion.span className={block ? styles.swapBlock : styles.swap} style={morph ? { width } : undefined}>
    {morph && <span ref={sizer} className={styles.sizer} aria-hidden="true">{text}</span>}
    <AnimatePresence key={reduceMotion ? "reduced" : "normal"} mode="popLayout" initial={false} custom={shown.direction}><OutgoingText key={text} className={styles.text} custom={shown.direction} variants={reduceMotion ? fade : rise} initial="hidden" animate="shown" exit="gone">{text}</OutgoingText></AnimatePresence>
  </motion.span>;
}

export function MetricCard({ label, value, locale, decimals, suffix, context, change, comparison }: MetricCardProps) {
  const reduceMotion = useLiveReducedMotion();
  const Arrow = comparison ? arrows[comparison.direction] : null;
  return <article className={styles.card}>
    <div className={styles.top}><span><Swap text={label} block /></span><AnimatePresence key={reduceMotion ? "reduced" : "normal"} initial={false}>{change && <ChangeChip key="change" data-trend={/^[+]/.test(change) ? "up" : /^[-−]/.test(change) ? "down" : undefined} initial={{ opacity: 0, scale: reduceMotion ? 1 : .96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: reduceMotion ? 1 : .96, transition: { duration: motionTokens.duration.fast, ease: [...motionTokens.ease.standard] } }} transition={reduceMotion ? { duration: 0 } : motionTokens.spring.snappy}><Swap text={change} morph /></ChangeChip>}</AnimatePresence></div>
    {typeof value === "number" ? <AnimatedCounter value={value} locale={locale} decimals={decimals} suffix={suffix} animateOnView /> : <strong className={styles.empty}>{value}</strong>}
    {comparison && Arrow && <p className={styles.comparison} data-tone={comparison.tone ?? "neutral"}>
      <Arrow className={styles.comparisonIcon} size={16} strokeWidth={1.75} aria-hidden="true" />
      <span className={styles.srOnly}>{directionText(locale ?? "es", comparison.direction)}: </span>
      <Swap text={comparison.text} block />
    </p>}
    <p><Swap text={context} block /></p>
  </article>;
}
