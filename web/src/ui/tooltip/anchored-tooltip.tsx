"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type ReactNode, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { motionTokens } from "../motion-tokens";
import styles from "./anchored-tooltip.module.css";

const gap = 8;
const margin = 8;

interface Place {
  left: number;
  top: number;
  side: "above" | "below";
}

/**
 * A floating label for whatever element is `anchor`, drawn above it (below when there is no room) and kept inside the
 * viewport. Moving to another anchor slides the same tooltip there instead of closing and reopening it, so scanning a
 * grid of cells reads as one continuous readout. The owner decides when it shows: pass `anchor={null}` to hide it, and
 * point the anchor's `aria-describedby` at `id` so the content is announced with it.
 */
export function AnchoredTooltip({
  anchor,
  id,
  children,
}: {
  anchor: HTMLElement | null;
  id: string;
  children: ReactNode;
}) {
  const reduced = useReducedMotion() ?? false;
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const [place, setPlace] = useState<Place>();

  // Hidden, it forgets where it was, so showing it again lands at once instead of gliding from an old spot.
  useLayoutEffect(() => {
    if (!anchor) setPlace(undefined);
  }, [anchor]);
  useLayoutEffect(() => {
    if (!anchor || !node) return;
    const measure = () => {
      const target = anchor.getBoundingClientRect();
      const width = node.offsetWidth,
        height = node.offsetHeight;
      const side = target.top - gap - height >= margin ? "above" : "below";
      const left = Math.min(
        Math.max(target.left + target.width / 2 - width / 2, margin),
        window.innerWidth - width - margin,
      );
      const top =
        side === "above" ? target.top - gap - height : target.bottom + gap;
      setPlace({ left, top, side });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [anchor, node]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <AnimatePresence>
      {anchor ? (
        <motion.div
          key="tooltip"
          ref={setNode}
          id={id}
          role="tooltip"
          data-lumen=""
          data-side={place?.side}
          className={styles.tooltip}
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{
            opacity: place ? 1 : 0,
            scale: 1,
            left: place?.left ?? 0,
            top: place?.top ?? 0,
          }}
          exit={{ opacity: 0, scale: 0.96 }}
          transition={
            reduced
              ? { duration: 0 }
              : {
                  opacity: { duration: motionTokens.duration.fast },
                  scale: { duration: motionTokens.duration.fast },
                  // The first placement lands at once; later moves glide between anchors.
                  left: place
                    ? motionTokens.spring.responsive
                    : { duration: 0 },
                  top: place ? motionTokens.spring.responsive : { duration: 0 },
                }
          }
        >
          {children}
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}

/** A title and label–value rows, the usual tooltip body. */
export function TooltipContent({
  title,
  rows,
  note,
}: {
  title: string;
  rows: [label: string, value: string][];
  note?: string;
}) {
  return (
    <>
      <p className={styles.title}>{title}</p>
      {rows.length ? (
        <dl className={styles.rows}>
          {rows.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {note ? <p className={styles.note}>{note}</p> : null}
    </>
  );
}
