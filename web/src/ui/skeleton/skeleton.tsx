"use client";

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { AnimatePresence, animate, motion, useMotionValue, useReducedMotion, type AnimationPlaybackControls } from "motion/react";
import { motionTokens } from "../motion-tokens";
import styles from "./skeleton.module.css";

export interface SkeletonProps {
  label?: string;
  lines?: number;
  avatar?: boolean;
  className?: string;
  /** Content to reveal once loading finishes. With children, the placeholder crossfades into them. */
  children?: ReactNode;
  /** Keeps the placeholder visible while true. Only used together with children. */
  loading?: boolean;
}

/** Follows its content height. After `morphKey` changes, the height springs from the old size to the new one and then returns to auto, so passive reflows (a resize, a font swap) follow instantly. It clips only while moving, so focus rings stay visible at rest. */
function HeightFrame({ className, busy, reduce, children }: { className?: string; busy: boolean; reduce: boolean | null; children: ReactNode }) {
  const frame = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const height = useMotionValue<number | "auto">("auto");
  const changedAt = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Loading state starts the height animation window.
  useLayoutEffect(() => { changedAt.current = performance.now(); }, [busy]);
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
      if (reduce || from === undefined || from === next || performance.now() - changedAt.current > 120) return settle();
      // Pin the old height before this frame paints, then spring to the new one.
      if (frame.current) Object.assign(frame.current.style, { overflow: "hidden", height: `${from}px` });
      controls = animate(height, [from, next], { ...motionTokens.spring.smooth, onComplete: settle });
    });
    observer.observe(node);
    return () => { observer.disconnect(); controls?.stop(); };
  }, [height, reduce]);
  // No aria-busy here: it would silence the loading status inside until loading ends.
  return <motion.div data-lumen="" ref={frame} className={className} style={{ height }}>
    <div ref={content} className={styles.frame}>{children}</div>
  </motion.div>;
}

/**
 * The status region is in the page before its text arrives: screen readers announce changes to a live region, not the
 * text it is inserted with. The blocks are decoration.
 */
function Placeholder({ label, avatar, count, className }: { label: string; avatar: boolean; count: number; className?: string }) {
  const [text, setText] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setText(label), 100);
    return () => window.clearTimeout(timer);
  }, [label]);
  // Each block pulses a beat after the one above it, so the wait reads as one calm wave.
  return <div data-lumen="" className={[styles.root, className].filter(Boolean).join(" ")} role="status">
    <span className={styles.srOnly}>{text}</span>
    {avatar && <span className={styles.avatar} aria-hidden="true" />}
    <span className={styles.lines} aria-hidden="true">{[0, 1, 2, 3, 4, 5].slice(0, count).map((index) => <span className={styles.line} style={{ "--index": index + (avatar ? 1 : 0) } as CSSProperties} key={index} />)}</span>
  </div>;
}

export function Skeleton({ label = "Loading content", lines = 3, avatar = false, className, children, loading = true }: SkeletonProps) {
  const reduce = useReducedMotion();
  const count = Math.min(Math.max(Math.floor(Number.isFinite(lines) ? lines : 3), 1), 6);
  const placeholder = (extra?: string) => <Placeholder label={label} avatar={avatar} count={count} className={extra} />;
  if (children === undefined) return placeholder(className);
  return <HeightFrame className={className} busy={loading} reduce={reduce}>
    <AnimatePresence mode="popLayout" initial={false}>
      {loading
        ? <motion.div key="placeholder" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: reduce ? motionTokens.duration.instant : motionTokens.duration.fast, ease: [...motionTokens.ease.standard] }} exit={{ opacity: 0, transition: { duration: reduce ? motionTokens.duration.instant : motionTokens.duration.fast } }}>{placeholder()}</motion.div>
        : <motion.div key="content" initial={reduce ? { opacity: 0 } : { opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, transition: { duration: reduce ? motionTokens.duration.instant : motionTokens.duration.fast } }} transition={{ duration: reduce ? motionTokens.duration.instant : motionTokens.duration.standard, ease: [...motionTokens.ease.enter] }}>{children}</motion.div>}
    </AnimatePresence>
  </HeightFrame>;
}

export default Skeleton;
