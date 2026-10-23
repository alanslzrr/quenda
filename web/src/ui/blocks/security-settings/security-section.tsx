import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type ReactNode, useId, useState } from "react";
import { Button } from "../../button/button";
import { motionTokens } from "../../motion-tokens";
import styles from "./security-settings.module.css";

/** Security-settings section with contextual editing; authentication belongs to the caller. */
export function SecuritySection({ title, description, action, closeLabel, status, children, defaultOpen = false }: {
  title: string; description?: string; action?: string; closeLabel?: string; status?: ReactNode; children: ReactNode; defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  const reduce = useReducedMotion();
  return <section className={styles.section} aria-labelledby={`${id}-heading`}>
    <div className={styles.sectionHead}><div className={styles.sectionText}><h2 id={`${id}-heading`}>{title}</h2>{description && <p>{description}</p>}</div>
      {(status || action) && <div className={styles.aside}>{status}{action && <Button size="sm" variant="secondary" aria-expanded={open} aria-controls={`${id}-content`} onClick={()=>setOpen(!open)}>{open ? closeLabel : action}</Button>}</div>}
    </div>
    <AnimatePresence initial={false}>{(!action || open) && <motion.div id={`${id}-content`} className={styles.collapse} initial={reduce ? false : {height:0,opacity:0}} animate={{height:"auto",opacity:1}} exit={{height:0,opacity:0}} transition={reduce ? {duration:0} : {height:motionTokens.spring.smooth,opacity:{duration:.15}}}><div className={styles.tfaBody}>{children}</div></motion.div>}</AnimatePresence>
  </section>;
}
