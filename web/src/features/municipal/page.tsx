import type { ReactNode } from "react";
import { PageHeader } from "../../ui/blocks/page-header/page-header";
import styles from "./page.module.css";

/**
 * The frame of every management section: the shared page header (breadcrumb, title with status, description, and the
 * section's main actions on the right) over one content width. `standard` keeps forms, text and short tables in a
 * readable column; `wide` is for screens built around a large table or chart, such as the agenda or the analysis.
 */
export function ManagementPage({
  title,
  description,
  actions,
  status,
  breadcrumb,
  width = "standard",
  children,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  status?: ReactNode;
  breadcrumb?: ReactNode;
  width?: "standard" | "wide";
  children: ReactNode;
}) {
  return (
    <div className={styles.page} data-width={width}>
      <PageHeader
        title={title}
        description={description}
        actions={actions}
        status={status}
        breadcrumb={breadcrumb}
      />
      {children}
    </div>
  );
}
