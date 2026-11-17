import { type ReactNode, useId } from "react";
import styles from "./record-card.module.css";

export type RecordDetail = { label: string; value: ReactNode };

/**
 * One record of a management list: its name and status on top, its facts as label and value pairs, and the
 * operations it allows as buttons at the foot, so what can be done with it never has to be found by hovering.
 */
export function RecordCard({
  title,
  status,
  details = [],
  actions,
  children,
}: {
  title: ReactNode;
  status?: ReactNode;
  details?: RecordDetail[];
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <section className={styles.card} aria-labelledby={id}>
      <header className={styles.header}>
        <h3 id={id} className={styles.title}>
          {title}
        </h3>
        {status}
      </header>
      {details.length > 0 && (
        <dl className={styles.details}>
          {details.map((d) => (
            <div key={d.label}>
              <dt>{d.label}</dt>
              <dd>{d.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {children}
      {actions && <footer className={styles.actions}>{actions}</footer>}
    </section>
  );
}

/** The stack that holds a list of {@link RecordCard}s. */
export function RecordList({ children }: { children: ReactNode }) {
  return <div className={styles.list}>{children}</div>;
}
