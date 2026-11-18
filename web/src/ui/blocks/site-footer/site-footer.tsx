import { motion, useInView } from "motion/react";
import { ArrowUpRight } from "lucide-react";
import { useId, useRef } from "react";
import type { ComponentType, ReactNode } from "react";
import { motionTokens } from "../../lib/motion-tokens";
import { useLiveReducedMotion } from "../../lib/use-live-reduced-motion";
import styles from "./site-footer.module.css";

export interface SiteFooterLink {
  label: string;
  href: string;
  /** Opens in a new tab and shows an outward arrow. */
  external?: boolean;
  /** A full page load, for paths the application does not route (served by the API). */
  document?: boolean;
}

export interface SiteFooterColumn {
  title: string;
  links: SiteFooterLink[];
}

/** The host's router link, used for internal destinations. */
export type SiteFooterLinkComponent = ComponentType<{
  to: string;
  className?: string;
  children: ReactNode;
}>;

export interface SiteFooterProps {
  /** The brand, already linked by the host. */
  brand: ReactNode;
  /** One short line under the brand. */
  tagline?: ReactNode;
  columns: SiteFooterColumn[];
  /** Small links beside the closing line, such as privacy and legal notice. */
  legal?: SiteFooterLink[];
  /** The closing line, such as the licence. */
  closing?: ReactNode;
  /** Ends in this word set across the whole width and revealed letter by letter. */
  mark?: string;
  linkComponent: SiteFooterLinkComponent;
  labels: { navigation: string; legal: string };
  className?: string;
}

type Bezier = [number, number, number, number];
const enter = [...motionTokens.ease.enter] as Bezier;

function FooterLink({
  link,
  Link,
}: {
  link: SiteFooterLink;
  Link: SiteFooterLinkComponent;
}) {
  if (link.external)
    return (
      <a
        className={styles.link}
        href={link.href}
        target="_blank"
        rel="noopener noreferrer"
      >
        {link.label}
        <ArrowUpRight
          className={styles.external}
          size={13}
          strokeWidth={2}
          aria-hidden="true"
        />
      </a>
    );
  if (link.document || link.href.startsWith("#"))
    return (
      <a className={styles.link} href={link.href}>
        {link.label}
      </a>
    );
  return (
    <Link to={link.href} className={styles.link}>
      {link.label}
    </Link>
  );
}

/**
 * The closing wordmark: the name set whole across the width, resting on the bottom edge, with a fine grain. Each
 * letter rises into place in turn the first time the footer scrolls into view.
 */
function WordReveal({ id, word }: { id: string; word: string }) {
  const reduced = useLiveReducedMotion();
  // Each letter starts outside its clipped slot, so the stage decides when the word is in view.
  const stage = useRef<HTMLDivElement>(null);
  const shown = useInView(stage, { once: true, amount: 0.25 });
  return (
    <div ref={stage} className={styles.wordStage} aria-hidden="true">
      <svg className={styles.grainDefs} width="0" height="0" aria-hidden="true" focusable="false">
        <filter id={id} x="0" y="0" width="100%" height="100%">
          <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" stitchTiles="stitch" result="noise" />
          <feColorMatrix in="noise" type="saturate" values="0" result="mono" />
          <feComponentTransfer in="mono" result="soft">
            <feFuncA type="linear" slope="0.07" />
          </feComponentTransfer>
          <feComposite in="soft" in2="SourceGraphic" operator="in" result="grain" />
          <feMerge>
            <feMergeNode in="SourceGraphic" />
            <feMergeNode in="grain" />
          </feMerge>
        </filter>
      </svg>
      <div className={styles.word} style={{ filter: `url(#${id})` }}>
        {Array.from(word, (letter, index) => ({ letter, index, key: `${index}:${letter}` })).map(({ letter, index, key }) => (
          <span key={key} className={styles.letterSlot}>
            <motion.span
              className={styles.letter}
              initial={reduced ? false : { y: "110%" }}
              animate={shown || reduced ? { y: "0%" } : { y: "110%" }}
              transition={{ duration: reduced ? 0 : 1.15, ease: enter, delay: reduced ? 0 : index * 0.07 }}
            >
              {letter}
            </motion.span>
          </span>
        ))}
      </div>
    </div>
  );
}

/** A website footer with link columns, a legal row and an optional closing mark. */
export function SiteFooter({
  brand,
  tagline,
  columns,
  legal = [],
  closing,
  mark,
  linkComponent,
  labels,
  className,
}: SiteFooterProps) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  return (
    <footer className={[styles.footer, mark ? styles.logo : "", className].filter(Boolean).join(" ")}>
      <div className={styles.top}>
        <div className={styles.intro}>
          {brand}
          {tagline && <p className={styles.tagline}>{tagline}</p>}
        </div>
        <nav className={styles.columns} aria-label={labels.navigation}>
          {columns.map((column, index) => (
            <div key={column.title} className={styles.column}>
              <h2 id={`${id}-column-${index}`}>{column.title}</h2>
              <ul aria-labelledby={`${id}-column-${index}`}>
                {column.links.map((link) => (
                  <li key={link.label}>
                    <FooterLink link={link} Link={linkComponent} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </div>
      <div className={styles.bottom}>
        {closing && <span className={styles.copyright}>{closing}</span>}
        {legal.length > 0 && (
          <ul className={styles.inline} aria-label={labels.legal}>
            {legal.map((link) => (
              <li key={link.label}>
                <FooterLink link={link} Link={linkComponent} />
              </li>
            ))}
          </ul>
        )}
      </div>
      {mark && <WordReveal id={`${id}-grain`} word={mark} />}
    </footer>
  );
}
