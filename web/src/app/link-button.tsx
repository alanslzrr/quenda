import { ChevronLeft, ChevronRight } from "lucide-react";
import type { ComponentProps } from "react";
import { Link } from "react-router";
import button from "../ui/button/button.module.css";
import styles from "./link-button.module.css";

type LinkProps = ComponentProps<typeof Link>;

/**
 * A navigation that reads as a button: it keeps native link semantics (opening in another tab, the link role) and the
 * button's outline, so an action never depends on hover to show it can be activated. `danger` is for one that leads
 * to withdrawing, revoking or removing something.
 */
export function LinkButton({
  variant = "secondary",
  size = "md",
  className = "",
  ...props
}: LinkProps & {
  variant?: "primary" | "secondary" | "danger";
  size?: "sm" | "md";
}) {
  return (
    <Link
      {...props}
      className={`${button.button} ${button[variant]} ${button[size]} ${styles.link} ${className}`}
    />
  );
}

/** The way up to the parent screen, shown above a page title. The leading chevron marks it as navigation. */
export function BackLink({ children, className = "", ...props }: LinkProps) {
  return (
    <Link {...props} className={`${styles.back} ${styles.link} ${className}`}>
      <ChevronLeft size={16} aria-hidden="true" />
      <span>{children}</span>
    </Link>
  );
}

/** A record's name inside a table or list that opens its detail; the trailing chevron marks it as one. */
export function RowLink({ children, className = "", ...props }: LinkProps) {
  return (
    <Link {...props} className={`${styles.row} ${styles.link} ${className}`}>
      <span>{children}</span>
      <ChevronRight size={16} aria-hidden="true" />
    </Link>
  );
}

/** A record's name that shows its detail on the same screen, styled as a {@link RowLink}; `aria-pressed` marks the shown one. */
export function RowButton({
  children,
  className = "",
  type = "button",
  ...props
}: ComponentProps<"button">) {
  return (
    <button
      {...props}
      type={type}
      className={`${styles.row} ${styles.rowButton} ${className}`}
    >
      <span>{children}</span>
      <ChevronRight size={16} aria-hidden="true" />
    </button>
  );
}
