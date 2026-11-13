"use client";

import { isValidElement, useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { AnimatePresence, animate, motion, useIsPresent, useMotionValue, type AnimationPlaybackControls, type HTMLMotionProps, type MotionProps, type TargetAndTransition, type Transition } from "motion/react";
import { Folder } from "lucide-react";
import { motionTokens } from "../lib/motion-tokens";
import { useLiveReducedMotion } from "../lib/use-live-reduced-motion";
import styles from "./empty-state.module.css";

/** A calm message where content would be, such as a period with no reservations, with an optional next step. */
export interface EmptyStateProps {
  title: string;
  description: string;
  action?: ReactNode;
  /** Decorative glyph. Defaults to a folder. */
  icon?: ReactNode;
  className?: string;
  /** Optional accessible label for the state region. */
  label?: string;
  /** Heading level of the title, so it fits the page outline. Defaults to 3. */
  headingLevel?: 2 | 3 | 4;
}

const exitFast: Transition = { duration: motionTokens.duration.fast, ease: [...motionTokens.ease.standard] };
const textIn: TargetAndTransition = { opacity: 0, y: "0.3em", filter: `blur(${motionTokens.blur.soft}px)` };
const textOut: TargetAndTransition = { opacity: 0, y: "-0.3em", filter: `blur(${motionTokens.blur.subtle}px)`, transition: exitFast };
const iconIn: TargetAndTransition = { opacity: 0, scale: .6, filter: `blur(${motionTokens.blur.subtle}px)` };
const shown: TargetAndTransition = { opacity: 1, y: "0em", scale: 1, filter: "blur(0px)" };
const fadeOut: TargetAndTransition = { opacity: 0, transition: { duration: motionTokens.duration.instant } };

/** Outgoing copies are hidden from assistive tech while they fade. */
function Swap(props: HTMLMotionProps<"span">) {
  const present = useIsPresent();
  return <motion.span {...props} aria-hidden={present ? props["aria-hidden"] : true} />;
}

const iconTypes = new WeakMap<object, number>();
let nextIconType = 0;
/** A new icon component crossfades in; re-rendering the same icon stays still. */
function iconKey(icon: ReactNode) {
  if (!isValidElement(icon)) return "icon";
  const type: unknown = icon.type;
  if (typeof type === "string") return `tag:${type}`;
  if ((typeof type === "object" && type !== null) || typeof type === "function") {
    let id = iconTypes.get(type);
    if (id === undefined) { id = ++nextIconType; iconTypes.set(type, id); }
    return `component:${id}`;
  }
  return `other:${String(type)}`;
}

/** Follows its content height. After the title or description changes, the height springs from the old size to the new one and then returns to auto, so passive reflows (a resize, a font swap) follow instantly. It clips only while moving, so focus rings stay visible at rest. */
function HeightFrame({ reduce, title, description, children }: { reduce: boolean; title: string; description: string; children: ReactNode }) {
  const frame = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const height = useMotionValue<number | "auto">("auto");
  useLayoutEffect(() => {
    if (!reduce) return;
    height.jump("auto");
    if (frame.current) Object.assign(frame.current.style, { overflow: "", height: "auto" });
  }, [reduce, height]);
  const changePending = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Changed copy opens the window in which the next resize animates.
  useLayoutEffect(() => {
    changePending.current = true;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => { changePending.current = false; });
    });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, [title, description]);
  useEffect(() => {
    const node = content.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    let last: number | undefined;
    let controls: AnimationPlaybackControls | undefined;
    const settle = () => { height.jump("auto"); if (frame.current) Object.assign(frame.current.style, { overflow: "", height: "auto" }); };
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const next = entry.borderBoxSize?.[0]?.blockSize ?? node.offsetHeight;
      const current = height.get();
      const from = typeof current === "number" ? current : last;
      last = next;
      controls?.stop();
      const changed = changePending.current;
      changePending.current = false;
      if (reduce || from === undefined || from === next || !changed) return settle();
      // Pin the old height before this frame paints, then spring to the new one.
      if (frame.current) Object.assign(frame.current.style, { overflow: "hidden", height: `${from}px` });
      controls = animate(height, [from, next], { ...motionTokens.spring.smooth, onComplete: settle });
    });
    observer.observe(node);
    return () => { observer.disconnect(); controls?.stop(); };
  }, [height, reduce]);
  return <motion.div ref={frame} className={styles.frame} style={{ height }}>
    <div ref={content} className={styles.copy}>{children}</div>
  </motion.div>;
}

export function EmptyState({ title, description, action, icon, className, label, headingLevel = 3 }: EmptyStateProps) {
  const Heading = `h${headingLevel}` as const;
  const reduce = useLiveReducedMotion();
  const glyph = icon ?? <Folder width={24} height={24} strokeWidth={1.5} />;
  const enter: Transition = reduce ? { duration: motionTokens.duration.instant } : { duration: motionTokens.duration.standard, ease: [...motionTokens.ease.enter] };
  const swap: MotionProps = { initial: reduce ? { opacity: 0 } : textIn, animate: shown, exit: reduce ? fadeOut : textOut, transition: enter };
  // The result of an action morphs in place: the icon crossfades and the copy rises in while the old copy leaves.
  return <section className={[styles.root, className].filter(Boolean).join(" ")} aria-label={label}>
    <div className={styles.icon} aria-hidden="true"><AnimatePresence key={reduce ? "reduced" : "normal"} mode="popLayout" initial={false}><Swap key={iconKey(glyph)} className={styles.glyph} initial={reduce ? { opacity: 0 } : iconIn} animate={shown} exit={reduce ? fadeOut : { ...iconIn, transition: exitFast }} transition={reduce ? enter : motionTokens.spring.snappy}>{glyph}</Swap></AnimatePresence></div>
    <HeightFrame reduce={reduce} title={title} description={description}>
      <Heading className={styles.title}><AnimatePresence key={reduce ? "reduced" : "normal"} mode="popLayout" initial={false}><Swap key={title} className={styles.line} {...swap}>{title}</Swap></AnimatePresence></Heading>
      <p><AnimatePresence key={reduce ? "reduced" : "normal"} mode="popLayout" initial={false}><Swap key={description} className={styles.line} {...swap}>{description}</Swap></AnimatePresence></p>
    </HeightFrame>
    {action && <div className={styles.action}>{action}</div>}
  </section>;
}

export default EmptyState;
