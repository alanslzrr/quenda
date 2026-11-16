import {
  createContext,
  useContext,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type SVGProps,
} from "react";
import {
  AnimatePresence,
  motion,
  useMotionValue,
  useReducedMotion,
  useTransform,

} from "motion/react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { Link } from "react-router";
import { motionTokens } from "../../motion-tokens";
import { Avatar } from "../../avatar/avatar";
import styles from "./sidebar-rail.module.css";

type IconComponent = ComponentType<SVGProps<SVGSVGElement> & { size?: number | string; strokeWidth?: number | string }>;
type NavEntry = {
  id: string;
  label: string;
  icon?: IconComponent;
  count?: number;
  children?: { id: string; label: string }[];
};
type NavSection = { id: string; heading?: string; items: NavEntry[] };
export interface SidebarRailProps {
  sections: NavSection[];
  active: string;
  onSelect: (id: string) => void;
  municipality: string;
  /** The municipality's own logo, shown instead of the product mark when it has one. */
  mark?: ReactNode;
  email: string;
  toolbar: ReactNode;
  children: ReactNode;
  labels: { navigation: string; expand: string; collapse: string; close: string; municipalities: string; account: string };
}
const RailContext = createContext<SidebarRailProps | null>(null);
function useRail() { const value = useContext(RailContext); if (!value) throw new Error("Missing navigation context"); return value; }
const bezier = (ease: readonly number[]) => [...ease] as [number, number, number, number];
const instant = { duration: 0 };
const labelIn = (reduced: boolean) =>
  reduced
    ? instant
    : { duration: 0.24, delay: 0.1, ease: bezier(motionTokens.ease.enter) };
const labelOut = (collapsed: boolean, reduced: boolean) =>
  reduced
    ? instant
    : collapsed
      ? { duration: 0.14, ease: bezier(motionTokens.ease.standard) }
      : { duration: 0.24, delay: 0.1, ease: bezier(motionTokens.ease.enter) };
const asideIn = (collapsed: boolean, reduced: boolean) =>
  reduced
    ? instant
    : collapsed
      ? { duration: 0.2, delay: 0.16, ease: bezier(motionTokens.ease.enter) }
      : { duration: 0.1, ease: bezier(motionTokens.ease.standard) };
function RailTip({
  enabled,
  label,
  note,
  children,
}: {
  enabled: boolean;
  label: string;
  note?: string;
  children: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  if (!enabled && hover) setHover(false);
  return (
    <TooltipPrimitive.Root
      open={enabled && hover}
      onOpenChange={(next) => setHover(next && enabled)}
    >
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          className={styles.tip}
          side="right"
          sideOffset={14}
          collisionPadding={8}
        >
          {label}
          {note ? <span className={styles.tipNote}>{note}</span> : null}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

function NavItem({
  entry,
  nested,
  current,
  lit,
  expanded,
  turned,
  controls,
  collapsed,
  tips,
  layoutId,
  reduce,
  onClick,
}: {
  entry: NavEntry;
  nested?: boolean;
  current?: boolean;
  lit?: boolean;
  expanded?: boolean;
  turned?: boolean;
  controls?: string;
  collapsed: boolean;
  tips: boolean;
  layoutId: string;
  reduce: boolean;
  onClick: () => void;
}) {
  const Icon = entry.icon;
  const Tag = entry.id.startsWith("/") ? "a" : "button";
  const fade = labelOut(collapsed, reduce);
  const aside = asideIn(collapsed, reduce);
  return (
    <RailTip
      enabled={tips}
      label={entry.label}
      note={entry.count ? `${entry.count} unread` : undefined}
    >
      <Tag
        href={Tag === "a" ? entry.id : undefined}
        type={Tag === "button" ? "button" : undefined}
        className={[styles.item, nested ? styles.nested : "", lit ? styles.lit : ""]
          .filter(Boolean)
          .join(" ")}
        aria-current={current ? "page" : undefined}
        aria-expanded={expanded}
        aria-controls={controls}
        onClick={(event) => { if (Tag === "a" && (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)) return; event.preventDefault(); onClick(); }}
      >
        {lit && (
          <motion.span
            layoutId={layoutId}
            className={styles.highlight}
            style={{ borderRadius: 8 }}
            transition={reduce ? instant : motionTokens.spring.morph}
          />
        )}
        {Icon && (
          <Icon className={styles.icon} size={16} strokeWidth={1.75} aria-hidden="true" />
        )}
        <motion.span
          className={styles.label}
          initial={false}
          animate={{ opacity: collapsed ? 0 : 1, x: collapsed ? -6 : 0 }}
          transition={fade}
        >
          {entry.label}
          {entry.count ? (
            <span className={styles.srOnly}>, {entry.count} unread</span>
          ) : null}
        </motion.span>
        {entry.count ? (
          <>
            <motion.span
              className={styles.count}
              aria-hidden="true"
              initial={false}
              animate={{ opacity: collapsed ? 0 : 1 }}
              transition={fade}
            >
              {entry.count}
            </motion.span>
            <motion.span
              className={styles.dot}
              aria-hidden="true"
              initial={false}
              animate={{ opacity: collapsed ? 1 : 0, scale: collapsed ? 1 : 0.3 }}
              transition={
                collapsed && !reduce
                  ? { ...motionTokens.spring.snappy, delay: 0.16 }
                  : aside
              }
            />
          </>
        ) : null}
        {turned !== undefined && (
          <motion.span
            className={styles.chevron}
            aria-hidden="true"
            initial={false}
            animate={{ opacity: collapsed ? 0 : 1, rotate: 90 * Number(!!turned) }}
            transition={{
              opacity: fade,
              rotate: reduce ? instant : motionTokens.spring.snappy,
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m9 6 6 6-6 6" />
            </svg>
          </motion.span>
        )}
      </Tag>
    </RailTip>
  );
}

function NavSections({
  variant,
  baseId,
  collapsed,
  active,
  open,
  reduce,
  onSelect,
  onGroup,
}: {
  variant: "side" | "sheet";
  baseId: string;
  collapsed: boolean;
  active: string;
  open: Record<string, boolean>;
  reduce: boolean;
  onSelect: (id: string) => void;
  onGroup: (id: string) => void;
}) {
  const { sections, labels } = useRail();
  const tips = variant === "side" && collapsed;
  const layoutId = `${baseId}-${variant}-active`;
  const fade = labelIn(reduce);
  const aside = asideIn(collapsed, reduce);
  const heightSpring = reduce ? instant : motionTokens.spring.smooth;
  const shared = { collapsed, tips, layoutId, reduce };
  return (
    <motion.nav className={styles.nav} aria-label={labels.navigation} layoutScroll>
      {sections.map((section) => {
        const headingId = `${baseId}-${variant}-${section.id}`;
        return (
    // biome-ignore lint/a11y/useSemanticElements: This named interaction group is not a form fieldset.
          <div
            key={section.id}
            className={styles.section}
            role="group"
            aria-labelledby={section.heading ? headingId : undefined}
          >
            {section.heading && (
              <motion.div
                className={styles.heading}
                initial={false}
                animate={{ height: collapsed ? 17 : 32 }}
                transition={heightSpring}
              >
                <motion.span
                  id={headingId}
                  className={styles.headingText}
                  initial={false}
                  animate={{ opacity: collapsed ? 0 : 1, x: collapsed ? -6 : 0 }}
                  transition={fade}
                >
                  {section.heading}
                </motion.span>
                <motion.span
                  className={styles.divider}
                  aria-hidden="true"
                  initial={false}
                  animate={{ opacity: collapsed ? 1 : 0, scaleX: collapsed ? 1 : 0.3 }}
                  transition={aside}
                />
              </motion.div>
            )}
            {/* biome-ignore lint/a11y/noRedundantRoles: Safari needs an explicit list role when list-style is none. */}
            <ul className={styles.list} role="list">
              {section.items.map((entry) => {
                if (!entry.children)
                  return (
                    <li key={entry.id}>
                      <NavItem
                        entry={entry}
                        current={active === entry.id}
                        lit={active === entry.id}
                        onClick={() => onSelect(entry.id)}
                        {...shared}
                      />
                    </li>
                  );
                const listId = `${baseId}-${variant}-${entry.id}-list`;
                const isOpen = !!open[entry.id] && !collapsed;
                const childActive = entry.children.some((child) => child.id === active);
                return (
                  <li key={entry.id}>
                    <NavItem
                      entry={entry}
                      current={false}
                      lit={childActive && !isOpen}
                      expanded={isOpen}
                      turned={!!open[entry.id]}
                      controls={listId}
                      onClick={() => onGroup(entry.id)}
                      {...shared}
                    />
                    <motion.ul
                      id={listId}
                      className={styles.children}
                      role="list"
                      inert={!isOpen}
                      initial={false}
                      animate={
                        isOpen
                          ? {
                              height: "auto",
                              opacity: 1,
                              transitionEnd: { overflow: "visible" },
                            }
                          : { height: 0, opacity: 0, overflow: "hidden" }
                      }
                      transition={{
                        height: heightSpring,
                        opacity: reduce
                          ? instant
                          : {
                              duration: isOpen ? 0.24 : 0.14,
                              delay: 0.06 * Number(!!isOpen),
                              ease: bezier(motionTokens.ease.standard),
                            },
                      }}
                    >
                      {entry.children.map((child) => (
                        <li key={child.id}>
                          <NavItem
                            entry={child}
                            nested
                            current={active === child.id}
                            lit={isOpen && active === child.id}
                            onClick={() => onSelect(child.id)}
                            {...shared}
                          />
                        </li>
                      ))}
                    </motion.ul>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </motion.nav>
  );
}

function Brand({ collapsed, reduce }: { collapsed: boolean; reduce: boolean }) {
  const { municipality, mark, labels } = useRail();
  return <Link to="/administracion" className={styles.brand}>
    {mark ?? <span className={styles.mark} aria-hidden="true">q</span>}
    <motion.span className={styles.stack} initial={false} animate={{opacity: collapsed ? 0 : 1, x: collapsed ? -6 : 0}} transition={labelOut(collapsed, reduce)}>
      <strong>{municipality}</strong><span>{labels.municipalities}</span>
    </motion.span>
  </Link>;
}
function Profile({ collapsed, reduce }: { collapsed: boolean; reduce: boolean }) {
  const { email, labels } = useRail();
  return <Link to="/perfil" className={styles.profile}>
    <Avatar name={email} size="sm" aria-hidden="true" />
    <motion.span className={styles.stack} initial={false} animate={{opacity: collapsed ? 0 : 1, x: collapsed ? -6 : 0}} transition={labelOut(collapsed, reduce)}>
      <strong>{labels.account}</strong><span>{email}</span>
    </motion.span>
  </Link>;
}

function RailGlyph({ collapsed, reduce }: { collapsed: boolean; reduce: boolean }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <rect x="2.75" y="3.75" width="14.5" height="12.5" rx="3.5" />
      <motion.path
        d="M8.25 4.25v11.5"
        initial={false}
        animate={{ x: collapsed ? -2.5 : 0 }}
        transition={reduce ? instant : motionTokens.spring.smooth}
      />
    </svg>
  );
}

/** The page region the layout focuses on every route change (it has tabindex="-1"). */
const pageOf = (node: HTMLElement | null) =>
  node?.closest<HTMLElement>("main") ?? document.getElementById("content");

/** A product app shell whose sidebar folds into an icon rail and opens as a sheet on narrow widths. */
export function SidebarRail(props: SidebarRailProps) {
 return <RailContext.Provider value={props}><RailBody /></RailContext.Provider>;
}
function RailBody() {
 const { active, onSelect, children, toolbar, labels } = useRail();
  const uid = useId();
  const reduceMotion = useReducedMotion() ?? false;
  const [mounted, setMounted] = useState(true);
  const reduce = reduceMotion || mounted;
  const [collapsed, setCollapsed] = useState(false);
  const [floating, setFloating] = useState(false);

  const [open, setOpen] = useState<Record<string, boolean>>({ projects: true });
  const [sheetOpen, setSheetOpen] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const shell = useRef<HTMLElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const railToggle = useRef<HTMLButtonElement>(null);
  // Set when a destination is chosen, so the overlay that closes after it hands focus to the new page instead of its trigger.
  const chose = useRef(false);
  const floated = useRef(false);
  const sheet = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const closeTimer = useRef(0);

  const sidebarId = `${uid}-sidebar`;

  useEffect(() => {
    if (!shell.current) return;
    const onKey = (event: KeyboardEvent) => {
      if (
        event.key !== "[" ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.defaultPrevented
      )
        return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
      )
        return;
      // A single-character shortcut is active only while focus is inside the navigation (WCAG 2.1.4).
      // The rail toggle that advertises the key counts as part of the navigation.
      if (
        !target ||
        !(
          document.getElementById(sidebarId)?.contains(target) ||
          target === railToggle.current
        )
      )
        return;
      const shellNode = shell.current;
      if (!shellNode) return;
      const rect = shellNode.getBoundingClientRect();
      if (!rect.width || rect.bottom < 0 || rect.top > window.innerHeight) return;
      event.preventDefault();
      if (shellNode.clientWidth < 480) {
        setSheetOpen((current) => !current);
        return;
      }
      setCollapsed((current) => {
        setAnnouncement(current ? labels.expand : labels.collapse);
        return !current;
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sidebarId, labels.expand, labels.collapse]);

  useLayoutEffect(() => {
    const node = shell.current;
    if (!node) return;
    let wasExpanded: boolean | null = null;
    const measure = () => {
      const width = node.clientWidth;
      if (width >= 480) setSheetOpen(false);
      const float = width >= 480 && width < 640;
      setFloating(float);
      const expanded = width >= 760;
      if (wasExpanded !== expanded) {
        wasExpanded = expanded;
        setCollapsed(!expanded);
      } else if (float) setCollapsed(true);
    };
    measure();
    const frame = requestAnimationFrame(() => setMounted(false));
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);
  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  const floatingSheet = floating && !collapsed;
  // Floating over the content, the sidebar acts as a drawer: focus moves into it while the page behind is inert, and
  // returns to the toggle when it folds (or to the page when it folded because a destination was chosen).
  useEffect(() => {
    const sidebar = document.getElementById(sidebarId);
    if (floatingSheet) {
      floated.current = true;
      // The current destination first, like the sheet; otherwise the first control.
      if (sidebar && !sidebar.contains(document.activeElement))
        [
          ...Array.from(sidebar.querySelectorAll<HTMLElement>("[aria-current='page']")),
          ...Array.from(sidebar.querySelectorAll<HTMLElement>("a[href], button")),
        ]
          .find((node) => !node.closest("[inert]"))
          ?.focus({ preventScroll: true });
      return;
    }
    if (!floated.current) return;
    floated.current = false;
    // Growing into a docked sidebar keeps focus where it is.
    if (!floating) return;
    const target = chose.current ? pageOf(shell.current) : railToggle.current;
    chose.current = false;
    target?.focus({ preventScroll: true });
  }, [floatingSheet, floating, sidebarId]);
  const collapse = () => {
    setCollapsed(true);
    setAnnouncement(labels.collapse);
  };
  const select = (id: string, fromSheet = false) => {
    if (fromSheet && dragging.current) return;
    onSelect(id);
    if (fromSheet || floatingSheet) {
      chose.current = true;
      window.clearTimeout(closeTimer.current);
      closeTimer.current = window.setTimeout(
        () => (fromSheet ? setSheetOpen(false) : setCollapsed(true)),
        200 * Number(!reduce),
      );
    }
  };
  const toggleGroup = (id: string, fromSheet = false) => {
    if (!fromSheet && collapsed) {
      setCollapsed(false);
      setOpen((current) => ({ ...current, [id]: true }));
      setAnnouncement(labels.expand);
      return;
    }
    setOpen((current) => ({ ...current, [id]: !current[id] }));
  };

  const dragX = useMotionValue("-100%");
  const dragProgress = useTransform(dragX, (value) => {
    const width = sheet.current?.offsetWidth || 288;
    const ratio =
      typeof value === "number"
        ? value / width
        : value.endsWith("%")
          ? parseFloat(value) / 100
          : parseFloat(value) / width;
    return Math.min(1, Math.max(0, 1 + (Number.isFinite(ratio) ? ratio : -1)));
  });
  return (
    <TooltipPrimitive.Provider delayDuration={250} skipDelayDuration={300}>
      <section
        ref={shell}
        className={styles.shell}
        aria-label={labels.navigation}
        onKeyDown={(event) => {
          if (event.key === "Escape" && floatingSheet && !event.defaultPrevented) {
            event.preventDefault();
            collapse();
          }
        }}
      >
        <motion.div
          className={styles.slot}
          initial={false}
          animate={{ width: floating || collapsed ? 64 : 240 }}
          transition={reduce ? instant : motionTokens.spring.smooth}
        >
          <motion.div
            id={sidebarId}
            className={styles.sidebar}
            initial={false}
            animate={{ width: collapsed ? 64 : 240 }}
            transition={reduce ? instant : motionTokens.spring.smooth}
            data-collapsed={collapsed || undefined}
            data-floating={floatingSheet || undefined}
            // Floating over an inert page it is a modal drawer, and says so; docked it is plain navigation.
            {...(floatingSheet
              ? { role: "dialog", "aria-modal": true, "aria-label": labels.navigation }
              : {})}
          >
            <Brand collapsed={collapsed} reduce={reduce} />
            <NavSections
              variant="side"
              baseId={uid}
              collapsed={collapsed}
              active={active}
              open={open}
              reduce={reduce}
              onSelect={(id) => select(id)}
              onGroup={(id) => toggleGroup(id)}
            />
            <Profile collapsed={collapsed} reduce={reduce} />
          </motion.div>
        </motion.div>
        <AnimatePresence>
          {floatingSheet && (
            <motion.div
              key="float-scrim"
              className={`${styles.scrim} ${styles.floatScrim}`}
              aria-hidden="true"
              onClick={collapse}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={
                reduce
                  ? instant
                  : {
                      duration: motionTokens.duration.standard,
                      ease: bezier(motionTokens.ease.standard),
                    }
              }
            />
          )}
        </AnimatePresence>
        <div className={styles.main} inert={floatingSheet}>
          <header className={styles.topbar}>
            <TooltipPrimitive.Root>
              <TooltipPrimitive.Trigger asChild>
                <button
                  ref={railToggle}
                  type="button"
                  className={`${styles.iconButton} ${styles.railToggle}`}
                  aria-label={collapsed ? labels.expand : labels.collapse}
                  aria-expanded={!collapsed}
                  aria-controls={sidebarId}
                  aria-keyshortcuts="["
                  onClick={() => {
                    setCollapsed((current) => {
                      setAnnouncement(
                        current ? labels.expand : labels.collapse,
                      );
                      return !current;
                    });
                  }}
                >
                  <RailGlyph collapsed={collapsed} reduce={reduce} />
                </button>
              </TooltipPrimitive.Trigger>
              <TooltipPrimitive.Portal>
                <TooltipPrimitive.Content
                  className={styles.tip}
                  side="bottom"
                  collisionPadding={8}
                >
                  <span className={styles.shortcut}>
                    {collapsed ? labels.expand : labels.collapse}
                    <kbd>[</kbd>
                  </span>
                </TooltipPrimitive.Content>
              </TooltipPrimitive.Portal>
            </TooltipPrimitive.Root>
            <button
              ref={menuButton}
              type="button"
              className={`${styles.iconButton} ${styles.menuButton}`}
              aria-label={labels.navigation}
              aria-haspopup="dialog"
              aria-expanded={sheetOpen}
              // No "[" shortcut here: at this width the rail is hidden, and the key only works while focus is inside it.
              onClick={() => setSheetOpen(true)}
            >
              <RailGlyph collapsed={false} reduce={reduce} />
            </button>
            <div className={styles.toolbar}>{toolbar}</div>
          </header>
          <div className={styles.content}>{children}</div>
        </div>
        {/* Outside .main, which turns inert while the sidebar floats; an inert live region is never spoken. */}
        <p className={styles.srOnly} aria-live="polite">
          {announcement}
        </p>
        <Dialog.Root open={sheetOpen} onOpenChange={setSheetOpen}>
          <AnimatePresence>
            {sheetOpen && shell.current && (
              <Dialog.Portal forceMount container={shell.current}>
                <Dialog.Overlay asChild forceMount>
                  <motion.div className={styles.scrim} style={{ opacity: dragProgress }} />
                </Dialog.Overlay>
                <Dialog.Content
                  asChild
                  forceMount
                  aria-describedby={undefined}
                  onCloseAutoFocus={(event) => {
                    event.preventDefault();
                    // A chosen destination lands on its page, like any route change; dismissing returns to the menu button.
                    const target = chose.current
                      ? pageOf(shell.current)
                      : menuButton.current;
                    chose.current = false;
                    target?.focus({ preventScroll: true });
                  }}
                  onOpenAutoFocus={(event) => {
                    chose.current = false;
                    const current = sheet.current?.querySelector("[aria-current='page']");
                    if (current && !current.closest("[inert]")) {
                      event.preventDefault();
                      (current as HTMLElement).focus();
                    }
                  }}
                >
                  <motion.div
                    ref={sheet}
                    className={styles.sheet}
                    style={{ x: dragX }}
                    initial={{ x: "-100%" }}
                    animate={{ x: 0 }}
                    exit={{ x: "-100%" }}
                    transition={reduce ? instant : motionTokens.spring.smooth}
                    drag={reduceMotion ? false : "x"}
                    dragConstraints={{ left: 0, right: 0 }}
                    dragElastic={{ left: 0.9, right: 0.04 }}
                    dragMomentum={false}
                    onDragStart={() => {
                      dragging.current = true;
                      sheet.current?.setAttribute("data-dragging", "");
                    }}
                    onDragEnd={(_event, info) => {
                      sheet.current?.removeAttribute("data-dragging");
                      window.setTimeout(() => {
                        dragging.current = false;
                      }, 0);
                      if (info.offset.x < -72 || info.velocity.x < -480)
                        setSheetOpen(false);
                    }}
                  >
                    <Dialog.Title className={styles.srOnly}>{labels.navigation}</Dialog.Title>
                    <div className={styles.sheetHead}>
                      <Brand collapsed={false} reduce={reduce} />
                      <Dialog.Close asChild>
                        <button
                          type="button"
                          className={styles.iconButton}
                          aria-label={labels.close}
                        >
                          <X size={18} strokeWidth={1.75} aria-hidden="true" />
                        </button>
                      </Dialog.Close>
                    </div>
                    <NavSections
                      variant="sheet"
                      baseId={uid}
                      collapsed={false}
                      active={active}
                      open={open}
                      reduce={reduce}
                      onSelect={(id) => select(id, true)}
                      onGroup={(id) => toggleGroup(id, true)}
                    />
                    <Profile collapsed={false} reduce={reduce} />
                  </motion.div>
                </Dialog.Content>
              </Dialog.Portal>
            )}
          </AnimatePresence>
        </Dialog.Root>
      </section>
    </TooltipPrimitive.Provider>
  );
}

export default SidebarRail;
