import { createContext, forwardRef, useContext, useId, useMemo, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { AnimatePresence, LayoutGroup, motion, useIsPresent } from "motion/react";
import type { Variants } from "motion/react";
import { ArrowRight, Plus } from "lucide-react";
import { SearchField } from "../../search-field/search-field";
import { motionTokens } from "../../lib/motion-tokens";
import { useLiveReducedMotion } from "../../lib/use-live-reduced-motion";
import styles from "./faq-section.module.css";

export type FaqSectionVariant = "accordion" | "columns" | "search";

export interface FaqItem {
  /** Stable id used for open state. Defaults to the question. */
  id?: string;
  question: string;
  /** Plain text answer; it is also what search matches. */
  answer: string;
  /** Groups questions in the columns variant. */
  category?: string;
  /** A short code shown before the question, such as a use case number. */
  badge?: string;
  /** One quiet line shown with the answer, such as who performs it. */
  meta?: string;
}

export interface FaqSectionProps {
  /** `accordion` is one centered list, `columns` groups questions beside a category rail, `search` filters as you type. */
  variant?: FaqSectionVariant;
  /** A short label above the title. */
  eyebrow?: string;
  title?: string;
  description?: string;
  items?: FaqItem[];
  /** Allow several answers open at once. Defaults to false. */
  multiple?: boolean;
  /** Open item ids (controlled). */
  value?: string[];
  /** Initially open item ids when uncontrolled. */
  defaultValue?: string[];
  onValueChange?: (value: string[]) => void;
  /** Active category in the columns variant (controlled). */
  category?: string;
  onCategoryChange?: (category: string) => void;
  /** Search text in the search variant (controlled). */
  query?: string;
  onQueryChange?: (query: string) => void;
  /** A way to reach a person when the answer isn't here. Pass null to hide it. */
  contact?: { label: string; description?: string; href?: string; onClick?: () => void } | null;
  /** Texts the section draws on its own, in the application's language. */
  labels: FaqSectionLabels;
  className?: string;
}

export interface FaqSectionLabels {
  topics: string;
  search: string;
  searchPlaceholder: string;
  results: (count: number) => string;
  total: (count: number) => string;
  empty: (query: string) => string;
  clear: string;
}

type Bezier = [number, number, number, number];
const enter = [...motionTokens.ease.enter] as Bezier;
const standard = [...motionTokens.ease.standard] as Bezier;
const { duration } = motionTokens;

const keyOf = (item: FaqItem) => item.id ?? item.question;
const normalize = (text: string) => text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/** Map each folded UTF-16 unit back to its original text range, including combining accents. */
function foldedRanges(text: string) {
  let folded = "", offset = 0, lowerOffset = 0;
  const starts: number[] = [], ends: number[] = [];
  const lowerStarts: number[] = [], lowerEnds: number[] = [];
  for (const char of text) {
    const end = offset + char.length;
    for (let i = 0; i < char.toLowerCase().length; i++) { lowerStarts.push(offset); lowerEnds.push(end); }
    offset = end;
  }
  // Lowercase as a whole so contextual mappings (for example final sigma) match search filtering.
  for (const char of text.toLowerCase()) {
    const end = lowerEnds[lowerOffset + char.length - 1]!, start = lowerStarts[lowerOffset]!;
    const part = char.normalize("NFD").replace(/[̀-ͯ]/g, "");
    if (part) {
      for (let i = 0; i < part.length; i++) { starts.push(start); ends.push(end); }
      folded += part;
    } else if (ends.length) ends[ends.length - 1] = end;
    lowerOffset += char.length;
  }
  return { folded, starts, ends };
}
const idPart = (text: string) => Array.from(text, char => char.codePointAt(0)!.toString(16)).join("-");
const ActiveStage = createContext(true);

/** Wraps each match of `query` in a mark, keeping the original casing. */
function Highlight({ text, query }: { text: string; query: string }) {
  const needle = normalize(query.trim());
  if (!needle) return <>{text}</>;
  const { folded: haystack, starts, ends } = foldedRanges(text);
  const parts: ReactNode[] = [];
  let from = 0, originalFrom = 0, at = haystack.indexOf(needle);
  while (at >= 0) {
    const start = starts[at]!, end = ends[at + needle.length - 1]!;
    if (start > originalFrom) parts.push(text.slice(originalFrom, start));
    parts.push(<mark key={at} className={styles.mark}>{text.slice(start, end)}</mark>);
    originalFrom = end;
    from = at + needle.length;
    at = haystack.indexOf(needle, from);
  }
  parts.push(text.slice(originalFrom));
  return <>{parts}</>;
}

/** A short window of the answer around the first match, for closed items that match only in their answer. */
function snippet(answer: string, query: string) {
  const { folded, starts, ends } = foldedRanges(answer);
  const needle = normalize(query.trim());
  const at = folded.indexOf(needle);
  if (at < 0) return null;
  const matchStart = starts[at]!, matchEnd = ends[at + needle.length - 1]!;
  const start = Math.max(0, answer.lastIndexOf(" ", Math.max(0, matchStart - 36)) + 1);
  let end = Math.min(answer.length, matchEnd + 60);
  if (end < answer.length && /[\uD800-\uDBFF]/.test(answer[end - 1]!) && /[\uDC00-\uDFFF]/.test(answer[end]!)) end++;
  return `${start > 0 ? "…" : ""}${answer.slice(start, end).trim()}${end < answer.length ? "…" : ""}`;
}

const panelVariants: Variants = {
  open: { height: "auto", opacity: 1, transition: { height: motionTokens.spring.smooth, opacity: { duration: duration.fast, ease: enter } } },
  closed: { height: 0, opacity: 0, transition: { height: motionTokens.spring.smooth, opacity: { duration: duration.instant, ease: standard } } },
};
const contentVariants: Variants = {
  open: { y: 0, filter: "blur(0px)", transition: { y: motionTokens.spring.smooth, filter: { duration: duration.fast, ease: enter } } },
  closed: { y: -6, filter: `blur(${motionTokens.blur.subtle}px)`, transition: { duration: duration.instant, ease: standard } },
};
const reducedPanel: Variants = { open: { height: "auto", opacity: 1, transition: { duration: 0 } }, closed: { height: 0, opacity: 0, transition: { duration: 0 } } };

/** Arrow keys, Home, and End move between the questions of one list. */
function onListKeyDown(event: KeyboardEvent<HTMLElement>) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const triggers = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[data-faq-trigger]")).filter(trigger => !trigger.closest("[inert]"));
  const index = triggers.indexOf(document.activeElement as HTMLElement);
  if (index < 0) return;
  event.preventDefault();
  const next = event.key === "Home" ? 0 : event.key === "End" ? triggers.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + triggers.length) % triggers.length;
  triggers[next]!.focus();
}

function Question({ item, open, onToggle, query = "", reduced, baseId, layout }: { item: FaqItem; open: boolean; onToggle: () => void; query?: string; reduced: boolean; baseId: string; layout?: boolean }) {
  const activeStage = useContext(ActiveStage);
  const present = useIsPresent() && activeStage;
  const key = keyOf(item);
  const safe = `${baseId}-${idPart(key)}`;
  const hint = query && !open && !normalize(item.question).includes(normalize(query.trim())) ? snippet(item.answer, query) : null;
  return <motion.li className={styles.item} data-open={open ? "" : undefined} aria-hidden={present ? undefined : true} inert={!present}
    layout={layout && !reduced ? "position" : false}
    initial={layout ? (reduced ? { opacity: 0 } : { opacity: 0, height: 0 }) : false}
    animate={{ opacity: 1, height: "auto" }}
    exit={reduced ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, height: 0, transition: { height: motionTokens.spring.smooth, opacity: { duration: duration.instant } } }}
    transition={reduced ? { duration: 0 } : { height: motionTokens.spring.smooth, opacity: { duration: duration.fast }, layout: motionTokens.spring.smooth }}>
    <ActiveStage.Provider value={present}><h3 className={styles.heading}>
      <button type="button" id={present ? `${safe}-q` : undefined} className={styles.trigger} data-faq-trigger="" aria-expanded={open} aria-controls={present ? `${safe}-a` : undefined} onClick={onToggle}>
        {item.badge && <span className={styles.badge}>{item.badge}</span>}
        <span className={styles.question}><Highlight text={item.question} query={query} /></span>
        <Plus className={styles.icon} size={18} strokeWidth={1.75} aria-hidden="true" />
      </button>
    </h3>
    <AnimatePresence initial={false}>
      {hint && <SearchHint key="hint" hint={hint} query={query} reduced={reduced} />}
    </AnimatePresence>
    <AnimatePresence initial={false}>
      {open && <AnswerPanel key={reduced ? "answer-reduced" : "answer-full"} safe={safe} item={item} query={query} reduced={reduced} />}
    </AnimatePresence>
    {!open && <section id={present ? `${safe}-a` : undefined} aria-labelledby={present ? `${safe}-q` : undefined} hidden inert aria-hidden="true" />}</ActiveStage.Provider>
  </motion.li>;
}

function SearchHint({ hint, query, reduced }: { hint: string; query: string; reduced: boolean }) {
  const activeStage = useContext(ActiveStage);
  const present = useIsPresent() && activeStage;
  return <motion.p className={styles.hint} aria-hidden={present ? undefined : true} inert={!present} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={reduced ? { duration: 0 } : { height: motionTokens.spring.smooth, opacity: { duration: duration.fast } }}>
    <Highlight text={hint} query={query} />
  </motion.p>;
}

function AnswerPanel({ safe, item, query, reduced }: { safe: string; item: FaqItem; query: string; reduced: boolean }) {
  const activeStage = useContext(ActiveStage);
  const present = useIsPresent() && activeStage;
  return <motion.div id={present ? `${safe}-a` : undefined} role="region" aria-labelledby={present ? `${safe}-q` : undefined} aria-hidden={present ? undefined : true} inert={!present} className={styles.panel} variants={reduced ? reducedPanel : panelVariants} initial="closed" animate="open" exit="closed">
    <motion.div className={styles.answer} variants={reduced ? undefined : contentVariants}>
      <p><Highlight text={item.answer} query={query} /></p>
      {item.meta && <p className={styles.meta}>{item.meta}</p>}
    </motion.div>
  </motion.div>;
}

const StageFace = forwardRef<HTMLDivElement, { direction: number; reduced: boolean; children: ReactNode }>(function StageFace({ direction, reduced, children }, ref) {
  const present = useIsPresent();
  return <motion.div ref={ref} className={styles.stageFace} custom={direction} aria-hidden={present ? undefined : true} inert={!present}
    initial={reduced ? { opacity: 0 } : { opacity: 0, y: direction * 16, filter: `blur(${motionTokens.blur.subtle}px)` }}
    animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
    exit={reduced ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: direction * -12, filter: `blur(${motionTokens.blur.subtle}px)`, transition: { duration: duration.instant, ease: standard } }}
    transition={reduced ? { duration: 0 } : { y: motionTokens.spring.smooth, opacity: { duration: duration.fast, ease: enter }, filter: { duration: duration.fast, ease: enter } }}>
    <ActiveStage.Provider value={present}>{children}</ActiveStage.Provider>
  </motion.div>;
});

function SearchEmpty({ query, clear, reduced, labels }: { query: string; clear: () => void; reduced: boolean; labels: FaqSectionLabels }) {
  const present = useIsPresent();
  return <motion.div className={styles.empty} aria-hidden={present ? undefined : true} inert={!present}
    initial={reduced ? { opacity: 0 } : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, transition: { duration: duration.instant } }}
    transition={{ duration: reduced ? 0 : duration.standard, ease: enter }}>
    <p>{labels.empty(query.trim())}</p>
    <button type="button" className={styles.clear} onClick={clear}>{labels.clear}</button>
  </motion.div>;
}

function Contact({ contact }: { contact: NonNullable<FaqSectionProps["contact"]> }) {
  const inner = <><span className={styles.contactText}><span>{contact.label}</span>{contact.description && <span>{contact.description}</span>}</span><ArrowRight className={styles.contactArrow} size={16} strokeWidth={1.75} aria-hidden="true" /></>;
  return contact.href
    ? <a className={styles.contact} href={contact.href} onClick={contact.onClick}>{inner}</a>
    : <button type="button" className={styles.contact} onClick={contact.onClick}>{inner}</button>;
}

/**
 * A frequently asked questions section in three layouts: one centered accordion, a category rail beside its questions,
 * and a searchable list that filters and highlights as you type. Answers open on a height spring with the icon turning
 * to a close mark; arrow keys move between questions.
 */
export const FaqSection = forwardRef<HTMLElement, FaqSectionProps>(function FaqSection({
  variant = "accordion",
  eyebrow,
  title,
  description,
  items = [],
  multiple = false,
  value,
  defaultValue,
  onValueChange,
  category: categoryProp,
  onCategoryChange,
  query: queryProp,
  onQueryChange,
  contact = null,
  labels,
  className,
}, ref) {
  const id = useId();
  const reduced = useLiveReducedMotion();
  const [innerOpen, setInnerOpen] = useState<string[]>(defaultValue ?? (items[0] ? [keyOf(items[0])] : []));
  const open = value ?? innerOpen;
  const categories = useMemo(() => Array.from(new Set(items.map(item => item.category ?? "General"))), [items]);
  const [innerCategory, setInnerCategory] = useState(categories[0] ?? "General");
  const activeCategory = categoryProp ?? (categories.includes(innerCategory) ? innerCategory : categories[0] ?? "General");
  if (categoryProp === undefined && innerCategory !== activeCategory) setInnerCategory(activeCategory);
  const [direction, setDirection] = useState(0);
  const [innerQuery, setInnerQuery] = useState("");
  const query = queryProp ?? innerQuery;

  const setOpen = (next: string[]) => { if (value === undefined) setInnerOpen(next); onValueChange?.(next); };
  const toggle = (key: string) => setOpen(open.includes(key) ? open.filter(entry => entry !== key) : multiple ? [...open, key] : [key]);
  const chooseCategory = (next: string) => {
    if (next === activeCategory) return;
    setDirection(Math.sign(categories.indexOf(next) - categories.indexOf(activeCategory)));
    if (categoryProp === undefined) setInnerCategory(next);
    onCategoryChange?.(next);
  };
  const setQuery = (next: string) => { if (queryProp === undefined) setInnerQuery(next); onQueryChange?.(next); };

  const needle = normalize(query.trim());
  const results = variant === "search" && needle ? items.filter(item => normalize(`${item.question} ${item.answer}`).includes(needle)) : items;
  const heading = <div className={styles.intro}>
    {eyebrow && <p className={styles.eyebrow}>{eyebrow}</p>}
      <h2 id={`${id}-title`} className={styles.title}>{title}</h2>
    {description && <p className={styles.description}>{description}</p>}
  </div>;
  const list = (entries: FaqItem[], layout = false) => <ul className={styles.list} onKeyDown={onListKeyDown}>
    <AnimatePresence initial={false}>
      {entries.map(item => <Question key={keyOf(item)} item={item} open={open.includes(keyOf(item))} onToggle={() => toggle(keyOf(item))} query={variant === "search" ? query : ""} reduced={reduced} baseId={id} layout={layout} />)}
    </AnimatePresence>
  </ul>;

  return <section ref={ref} className={[styles.faq, styles[variant], className].filter(Boolean).join(" ")} aria-labelledby={`${id}-title`}>
    {variant === "accordion" && <div className={styles.stack}>
      {heading}
      {list(items)}
      {contact && <Contact contact={contact} />}
    </div>}

    {variant === "columns" && <div className={styles.columnsGrid}>
      <div className={styles.rail}>
        {heading}
        <LayoutGroup id={`${id}-rail`}>
          <fieldset className={styles.categories}>
            <legend className={styles.srOnly}>{labels.topics}</legend>
            {categories.map(entry => {
              const count = items.filter(item => (item.category ?? "General") === entry).length;
              return <button key={entry} type="button" className={styles.category} aria-pressed={entry === activeCategory} onClick={() => chooseCategory(entry)}>
                {entry === activeCategory && <motion.span layoutId="category" className={styles.categoryHighlight} transition={reduced ? { duration: 0 } : motionTokens.spring.morph} aria-hidden="true" />}
                <span>{entry}</span><span className={styles.count}>{count}</span>
              </button>;
            })}
          </fieldset>
        </LayoutGroup>
        {contact && <Contact contact={contact} />}
      </div>
      <div className={styles.stage}>
        <AnimatePresence initial={false} mode="popLayout" custom={direction}>
          <StageFace key={activeCategory} direction={direction} reduced={reduced}>
            {list(items.filter(item => (item.category ?? "General") === activeCategory))}
          </StageFace>
        </AnimatePresence>
      </div>
    </div>}

    {variant === "search" && <div className={styles.stack}>
      {heading}
      <div className={styles.searchRow}>
        <SearchField label={labels.search} clearLabel={labels.clear} placeholder={labels.searchPlaceholder} value={query} onValueChange={setQuery} />
        <p className={styles.resultCount} aria-live="polite">{needle ? labels.results(results.length) : labels.total(items.length)}</p>
      </div>
      {list(results, true)}
      <AnimatePresence initial={false}>
        {needle && results.length === 0 && <SearchEmpty key="empty" query={query} clear={() => setQuery("")} reduced={reduced} labels={labels} />}
      </AnimatePresence>
      {contact && <Contact contact={contact} />}
    </div>}
  </section>;
});

FaqSection.displayName = "FaqSection";

