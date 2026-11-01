import type { ComponentProps } from "react";
import { Link } from "react-router";
import button from "../ui/button/button.module.css";
import styles from "./link-button.module.css";

/** Navigation retains native link semantics, including opening in another tab. */
export function LinkButton({
  variant = "secondary",
  className = "",
  ...props
}: ComponentProps<typeof Link> & {
  variant?: "primary" | "secondary" | "quiet";
}) {
  return (
    <Link
      {...props}
      className={`${variant === "quiet" ? styles.action : `${button.button} ${button[variant]}`} ${styles.link} ${className}`}
    />
  );
}
export function ActionLink(props: ComponentProps<typeof Link>) {
  return <LinkButton {...props} variant="quiet" />;
}
