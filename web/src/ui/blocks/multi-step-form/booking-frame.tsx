import type { ReactNode } from "react";
import { Check } from "lucide-react";
import styles from "./multi-step-form.module.css";

/** Multi-step composition driven by real routes rather than a second form state machine. */
export function BookingFrame({ index, labels, progressLabel, children }: { index: 0 | 1; labels: [string,string]; progressLabel:string; children:ReactNode }) {
  return <div className={styles.form}><nav className={styles.progress} aria-label={progressLabel}>
    <ol className={styles.progressList}>{labels.map((label,at)=><li key={label} className={[styles.progressItem,at===index?styles.current:"",at<index?styles.complete:""].join(" ")} aria-current={at===index?"step":undefined}>
      <span className={styles.progressMarker} aria-hidden="true">{at<index ? <Check size={12}/> : at+1}</span><span className={styles.progressLabel}>{label}</span>
    </li>)}</ol><span className={styles.progressCount}>{index+1} / {labels.length}</span>
  </nav><div className={styles.viewport}>{children}</div></div>;
}
