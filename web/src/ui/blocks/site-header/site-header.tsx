import { AnimatePresence, LayoutGroup, motion, useIsPresent } from "motion/react";
import type { HTMLMotionProps, Transition } from "motion/react";
import { Menu, X } from "lucide-react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { motionTokens } from "../../lib/motion-tokens";
import { useLiveReducedMotion } from "../../lib/use-live-reduced-motion";
import styles from "./site-header.module.css";

/** A destination in the bar: an in-page anchor or a route the host renders as a plain link. */
export interface SiteHeaderItem {
  value: string;
  label: string;
  href: string;
}

export interface SiteHeaderProps {
  /** The brand, already linked by the host. */
  brand: ReactNode;
  items: SiteHeaderItem[];
  /** Value of the section in view; the indicator glides to it. */
  current?: string;
  /** Called when a destination is chosen, before the browser follows it. */
  onNavigate?: (item: SiteHeaderItem) => void;
  /** Actions at the end of the bar, such as sign-in and the main call to action. Repeated in the narrow sheet. */
  actions?: ReactNode;
  /** Tools that stay in the bar on every width, such as a settings menu. */
  tools?: ReactNode;
  /** Accessible name of the navigation landmark. */
  label: string;
  menuLabels: { open: string; close: string };
  className?: string;
}

type Bezier = [number, number, number, number];
const enter = [...motionTokens.ease.enter] as Bezier;
const standard = [...motionTokens.ease.standard] as Bezier;
/** Duration based springs restated as stiffness and damping, so a retarget keeps the velocity already in flight. */
const physical = (visualDuration: number, bounce: number): Transition => {
  const root = (2 * Math.PI) / (visualDuration * 1.2);
  return {
    type: "spring",
    stiffness: root * root,
    damping: 2 * (1 - bounce) * root,
    mass: 1,
  };
};
const GROW = physical(0.44, 0);
const SHRINK = physical(0.34, 0);
const GLIDE = physical(0.3, 0);
/** Matches the container query in site-header.module.css. */
const COLLAPSE_BELOW = 760;

function useScrolled(threshold: number) {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    // Turns solid past the threshold and clear again only near the top, so it never flickers at the edge.
    const update = () =>
      setScrolled((previous) =>
        previous ? window.scrollY > threshold / 2 : window.scrollY > threshold,
      );
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, [threshold]);
  return scrolled;
}

/** The sheet keeps its exit animation, never its keyboard focus or its links. */
const SheetLayer = forwardRef<
  HTMLDivElement,
  HTMLMotionProps<"div"> & { focusTarget?: () => HTMLElement | null }
>(function SheetLayer({ focusTarget, children, ...props }, forwarded) {
  const present = useIsPresent();
  const node = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (!present && node.current?.contains(document.activeElement))
      focusTarget?.()?.focus();
  }, [present, focusTarget]);
  return (
    <motion.div
      {...props}
      ref={(value) => {
        node.current = value;
        if (typeof forwarded === "function") forwarded(value);
        else if (forwarded) forwarded.current = value;
      }}
      inert={!present}
      aria-hidden={!present || undefined}
    >
      {children}
    </motion.div>
  );
});

/**
 * A website header that sticks to the top and turns solid once the page scrolls. The section in view carries an
 * indicator that glides between links, and narrow containers fold the links into a sheet.
 */
export function SiteHeader({
  brand,
  items,
  current,
  onNavigate,
  actions,
  tools,
  label,
  menuLabels,
  className,
}: SiteHeaderProps) {
  const id = useId();
  const reduced = useLiveReducedMotion();
  const scrolled = useScrolled(8);
  const [hovered, setHovered] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLElement | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  const closeMenu = useCallback((restoreFocus = false) => {
    setMenuOpen(false);
    if (restoreFocus) menuButtonRef.current?.focus();
  }, []);

  // Outside presses and Escape close the sheet.
  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) closeMenu();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === "Escape") closeMenu(true);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen, closeMenu]);

  // The sheet belongs to narrow layouts: widening the container closes it, and it holds the page still while open.
  useEffect(() => {
    const node = rootRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width >= COLLAPSE_BELOW)
        setMenuOpen(false);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!menuOpen) return;
    const scroller = document.documentElement;
    const previous = scroller.style.overflow;
    scroller.style.overflow = "hidden";
    return () => {
      scroller.style.overflow = previous;
    };
  }, [menuOpen]);

  function onNavKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const links = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>("[data-nav-item]"),
    );
    const index = links.indexOf(document.activeElement as HTMLElement);
    if (index < 0) return;
    event.preventDefault();
    const next =
      (index + (event.key === "ArrowRight" ? 1 : -1) + links.length) %
      links.length;
    links[next]?.focus();
  }

  const canHover = (event: React.PointerEvent) =>
    event.pointerType === "mouse" &&
    window.matchMedia("(hover: hover) and (pointer: fine)").matches;

  return (
    <header
      ref={rootRef}
      className={[styles.header, className].filter(Boolean).join(" ")}
      data-scrolled={scrolled || menuOpen ? "" : undefined}
    >
      <div className={styles.inner}>
        <div className={styles.bar}>
          <div className={styles.brandSlot}>{brand}</div>
          <LayoutGroup id={id}>
            <nav
              className={styles.nav}
              aria-label={label}
              onKeyDown={onNavKeyDown}
              onPointerLeave={() => setHovered(null)}
            >
              <ul className={styles.navList}>
                {items.map((item) => {
                  const isCurrent = current === item.value;
                  return (
                    <li key={item.value} className={styles.navCell}>
                      <a
                        href={item.href}
                        className={styles.navItem}
                        data-nav-item=""
                        data-current={isCurrent ? "" : undefined}
                        aria-current={isCurrent ? "location" : undefined}
                        onPointerEnter={(event) => {
                          if (canHover(event)) setHovered(item.value);
                        }}
                        onFocus={() => setHovered(null)}
                        onClick={() => onNavigate?.(item)}
                      >
                        {hovered === item.value && (
                          <motion.span
                            layoutId="hover"
                            className={styles.hover}
                            transition={reduced ? { duration: 0 } : GLIDE}
                            aria-hidden="true"
                          />
                        )}
                        {isCurrent && (
                          <motion.span
                            layoutId="current"
                            className={styles.indicator}
                            transition={
                              reduced ? { duration: 0 } : motionTokens.spring.morph
                            }
                            aria-hidden="true"
                          />
                        )}
                        <span className={styles.navLabel}>{item.label}</span>
                      </a>
                    </li>
                  );
                })}
              </ul>
            </nav>
          </LayoutGroup>
          <div className={styles.actions}>
            {actions && <div className={styles.wideOnly}>{actions}</div>}
            {tools}
            <button
              ref={menuButtonRef}
              type="button"
              className={styles.menuButton}
              aria-expanded={menuOpen}
              aria-controls={`${id}-sheet`}
              aria-label={menuOpen ? menuLabels.close : menuLabels.open}
              onClick={() => (menuOpen ? closeMenu() : setMenuOpen(true))}
            >
              <AnimatePresence initial={false} mode="popLayout">
                <motion.span
                  key={menuOpen ? "close" : "open"}
                  className={styles.menuIcon}
                  initial={
                    reduced
                      ? { opacity: 0 }
                      : { opacity: 0, rotate: menuOpen ? -45 : 45, scale: 0.8 }
                  }
                  animate={{ opacity: 1, rotate: 0, scale: 1 }}
                  exit={
                    reduced
                      ? { opacity: 0 }
                      : { opacity: 0, rotate: menuOpen ? 45 : -45, scale: 0.8 }
                  }
                  transition={
                    reduced
                      ? { duration: 0 }
                      : {
                          ...motionTokens.spring.snappy,
                          opacity: { duration: motionTokens.duration.instant },
                        }
                  }
                >
                  {menuOpen ? (
                    <X size={20} strokeWidth={1.75} aria-hidden="true" />
                  ) : (
                    <Menu size={20} strokeWidth={1.75} aria-hidden="true" />
                  )}
                </motion.span>
              </AnimatePresence>
            </button>
          </div>
        </div>
      </div>

      <AnimatePresence>
        {menuOpen && (
          <>
            <motion.div
              key="scrim"
              className={styles.scrim}
              onClick={() => closeMenu()}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{
                duration: reduced ? 0 : motionTokens.duration.standard,
                ease: standard,
              }}
              aria-hidden="true"
            />
            <SheetLayer
              key="sheet"
              id={`${id}-sheet`}
              focusTarget={() => menuButtonRef.current}
              className={styles.sheet}
              initial={reduced ? { opacity: 0 } : { height: 0 }}
              animate={reduced ? { opacity: 1 } : { height: "auto" }}
              exit={reduced ? { opacity: 0 } : { height: 0, transition: SHRINK }}
              transition={reduced ? { duration: 0 } : GROW}
            >
              <nav className={styles.sheetInner} aria-label={label}>
                <ul className={styles.sheetList}>
                  {items.map((item, index) => {
                    const isCurrent = current === item.value;
                    return (
                      <motion.li
                        key={item.value}
                        className={styles.sheetItem}
                        initial={reduced ? false : { opacity: 0, y: -6 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{
                          duration: motionTokens.duration.standard,
                          ease: enter,
                          delay: reduced
                            ? 0
                            : 0.04 + index * motionTokens.stagger.item,
                        }}
                      >
                        <a
                          href={item.href}
                          className={styles.sheetRow}
                          data-current={isCurrent ? "" : undefined}
                          aria-current={isCurrent ? "location" : undefined}
                          onClick={() => {
                            onNavigate?.(item);
                            closeMenu();
                          }}
                        >
                          <span>{item.label}</span>
                          {isCurrent && (
                            <span className={styles.sheetDot} aria-hidden="true" />
                          )}
                        </a>
                      </motion.li>
                    );
                  })}
                </ul>
                {actions && (
                  <motion.div
                    className={styles.sheetActions}
                    onClickCapture={() => closeMenu()}
                    initial={reduced ? false : { opacity: 0, y: -6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{
                      duration: motionTokens.duration.standard,
                      ease: enter,
                      delay: reduced
                        ? 0
                        : 0.04 + items.length * motionTokens.stagger.item,
                    }}
                  >
                    {actions}
                  </motion.div>
                )}
              </nav>
            </SheetLayer>
          </>
        )}
      </AnimatePresence>
    </header>
  );
}

/** Class names for the host's own action links, so routed links look like the bar's actions. */
export const siteHeaderAction = {
  primary: `${styles.action} ${styles.primary}`,
  secondary: `${styles.action} ${styles.secondary}`,
};
