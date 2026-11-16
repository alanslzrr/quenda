"use client";

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { LayoutGroup, motion, useReducedMotion } from "motion/react";
import { motionTokens } from "../motion-tokens";
import styles from "./segmented-control.module.css";

export interface Segment {
  value: string;
  label: string;
  /** Optional content after the label, such as a badge. */ accessory?: ReactNode;
}
export interface SegmentedControlProps {
  options: Segment[];
  value: string;
  onValueChange: (value: string) => void;
  /** Names the choice. Pass this or `labelledBy`: a radio group needs a name. */
  label?: string;
  /** The id of a visible element that names the choice. */
  labelledBy?: string;
  /** Called when the pointer or focus reaches an option, before it is chosen. Use it to start loading what that option shows. */
  onOptionIntent?: (value: string) => void;
  className?: string;
}

export default function SegmentedControl({
  options,
  value,
  onValueChange,
  label,
  labelledBy,
  onOptionIntent,
  className,
}: SegmentedControlProps) {
  const id = useId();
  const reduced = useReducedMotion();
  const track = useRef<HTMLDivElement>(null);

  // When the options are wider than the container, the track scrolls inside itself. Edges fade only on the side with more to see.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Reobserve the replaced option elements after an options change.
  useLayoutEffect(() => {
    const node = track.current;
    if (!node) return;
    const edges = () => {
      const rest = node.scrollWidth - node.clientWidth - node.scrollLeft;
      node.toggleAttribute("data-fade-start", node.scrollLeft > 1);
      node.toggleAttribute("data-fade-end", rest > 1);
    };
    edges();
    node.addEventListener("scroll", edges, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(edges);
    observer?.observe(node);
    for (const child of node.children) observer?.observe(child);
    return () => {
      node.removeEventListener("scroll", edges);
      observer?.disconnect();
    };
  }, [options]);

  // The selected option is always scrolled fully into view, with a little room so it clears the fade.
  const first = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Selection and option changes must reveal the new active element.
  useEffect(() => {
    const node = track.current;
    if (!node) return;
    const reveal = (behavior: ScrollBehavior) => {
      const button = node.querySelector<HTMLElement>('[aria-checked="true"]');
      if (!button || node.scrollWidth <= node.clientWidth) return;
      // Rectangles share a coordinate system even when the host is positioned.
      const start = button.getBoundingClientRect().left - node.getBoundingClientRect().left + node.scrollLeft - 20;
      const end = start + button.offsetWidth + 40 - node.clientWidth;
      const left = node.scrollLeft > start ? start : node.scrollLeft < end ? end : node.scrollLeft;
      if (left !== node.scrollLeft) node.scrollTo({left: Math.max(0, left), behavior});
    };
    reveal(first.current || reduced ? "auto" : "smooth");
    first.current = false;
    // A host resize or font/label reflow must not hide the controlled selection.
    const dimensions = () => [node.clientWidth, node.scrollWidth, ...Array.from(node.children, child => (child as HTMLElement).offsetWidth)].join(":");
    let previous = dimensions();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => {
      const next = dimensions();
      if (next !== previous) { previous = next; reveal("auto"); }
    });
    observer?.observe(node);
    for (const child of node.children) observer?.observe(child);
    return () => observer?.disconnect();
  }, [value, reduced, options]);

  // One exclusive choice is a radio group: arrow keys, Home and End move focus and the selection together, and only the
  // selected option is a tab stop. A consumer whose change has a cost (a save) defers that cost, not the selection.
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const last = options.length - 1;
    const target =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? selectedIndex === last
          ? 0
          : selectedIndex + 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? selectedIndex === 0
            ? last
            : selectedIndex - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : -1;
    if (target < 0 || !options[target]) return;
    event.preventDefault();
    onValueChange(options[target].value);
    track.current
      ?.querySelector<HTMLElement>(
        `[data-value="${CSS.escape(options[target].value)}"]`,
      )
      ?.focus({ preventScroll: true });
  };

  return (
    <div
      className={`${styles.root} ${className ?? ""}`}
      role="radiogroup"
      aria-label={label}
      aria-labelledby={labelledBy}
    >
      <LayoutGroup id={id}>
        <motion.div ref={track} layoutScroll className={styles.track}>
          {options.map((option, index) => (
            // biome-ignore lint/a11y/useSemanticElements: Native radios cannot carry the shared sliding selection, so each option is a button.
            <button
              key={option.value}
              id={`${id}-${option.value}`}
              className={styles.button}
              type="button"
              data-value={option.value}
              role="radio"
              aria-checked={value === option.value}
              tabIndex={index === selectedIndex ? 0 : -1}
              onClick={() => onValueChange(option.value)}
              onKeyDown={onKeyDown}
              onPointerEnter={
                onOptionIntent ? () => onOptionIntent(option.value) : undefined
              }
              onFocus={
                onOptionIntent ? () => onOptionIntent(option.value) : undefined
              }
            >
              {value === option.value && (
                <motion.span
                  className={styles.selection}
                  layoutId="selection"
                  layoutDependency={value}
                  transition={
                    reduced ? { duration: 0 } : motionTokens.spring.morph
                  }
                  aria-hidden="true"
                />
              )}
              <span className={styles.label}>
                {option.label}
                {option.accessory}
              </span>
            </button>
          ))}
        </motion.div>
      </LayoutGroup>
    </div>
  );
}
