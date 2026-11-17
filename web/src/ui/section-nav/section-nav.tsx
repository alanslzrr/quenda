import { type ComponentType, type SVGProps, useId } from "react";
import { Link } from "react-router";
import styles from "./section-nav.module.css";

export type SectionNavItem = {
  to: string;
  label: string;
  current?: boolean;
  icon?: ComponentType<SVGProps<SVGSVGElement> & { size?: number | string }>;
};
export type SectionNavGroup = { label?: string; items: SectionNavItem[] };

/**
 * The views of one screen, drawn as a framed track of links with the current one raised, so every destination reads
 * as selectable before it is hovered. Groups split views to consult from operations to perform; each keeps its own
 * track and caption, and a track too wide for its column wraps onto another row instead of hiding views.
 */
export function SectionNav({
  label,
  groups,
}: {
  label: string;
  groups: SectionNavGroup[];
}) {
  const id = useId();
  const shown = groups.filter((g) => g.items.length);
  return (
    <nav className={styles.nav} aria-label={label}>
      {shown.map((group, index) => (
        <div key={group.label ?? group.items[0].to} className={styles.group}>
          {group.label && (
            <span id={`${id}-${index}`} className={styles.caption}>
              {group.label}
            </span>
          )}
          <ul
            className={styles.track}
            aria-labelledby={group.label ? `${id}-${index}` : undefined}
          >
            {group.items.map(({ to, label: text, current, icon: Icon }) => (
              <li key={to}>
                <Link
                  to={to}
                  className={styles.item}
                  aria-current={current ? "page" : undefined}
                >
                  {Icon && <Icon size={16} aria-hidden="true" />}
                  {text}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}
