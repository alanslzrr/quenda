import { ChevronRight } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { Button } from "../ui/button/button";
import styles from "./disclosure.module.css";
import { usePreferences } from "./preferences-provider";

/** A text-only Lumen disclosure: no native summary marker or decorative icon. */
export function Disclosure({
  title,
  children,
}: {
  title: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const { t } = usePreferences();
  return (
    <div>
      <Button
        type="button"
        variant="ghost"
        className={styles.trigger}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRight size={16} aria-hidden="true" className={styles.chevron} />
        {title}
        {open && (
          <span className={styles.state}>{t("Ocultar", "Ocultar")}</span>
        )}
      </Button>
      <div id={id} hidden={!open}>
        {children}
      </div>
    </div>
  );
}
