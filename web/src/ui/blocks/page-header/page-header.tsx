import type { ReactNode } from "react";
import styles from "./page-header.module.css";

/** Page-header composition with application-owned breadcrumbs, status and actions. */
export function PageHeader({ title, breadcrumb, status, description, actions, children }: {
  title: string; breadcrumb?: ReactNode; status?: ReactNode; description?: ReactNode; actions?: ReactNode; children?: ReactNode;
}) {
  return <header className={styles.header}>
    <div className={styles.bar}><div className={styles.crumbs}>{breadcrumb}</div><div className={styles.actions}>{actions}</div></div>
    <div className={styles.intro}><div className={styles.introInner}>
      <div className={styles.titleRow}><h1 className={styles.title}>{title}</h1>{status}</div>
      {description && <p className={styles.description}>{description}</p>}
    </div></div>
    {children}
  </header>;
}
