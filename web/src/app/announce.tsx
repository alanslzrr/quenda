import { useEffect, useRef, useSyncExternalStore } from "react";

// One persistent live region lets outcomes be announced even when the control that caused them unmounts.
let message = { text: "", id: 0, at: 0 };
const listeners = new Set<() => void>();

export function announce(text: string) {
  // A form and the action that navigates away from it may both report one outcome; it is spoken once.
  const at = Date.now();
  if (text === message.text && at - message.at < 1000) return;
  message = { text, id: message.id + 1, at };
  for (const listener of listeners) listener();
}

let delayed: number | undefined;

/**
 * Field errors are not live regions themselves: one that is shown, rather than changed, is not announced reliably.
 * The field's owner calls the returned handler on blur; the error is spoken once per appearance, a moment later so it
 * does not talk over the field that receives focus next. While focused, the field reads it through aria-describedby.
 */
export function useFieldErrorAnnouncement(label: string, error?: string) {
  const spoken = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!error) spoken.current = undefined;
  }, [error]);
  return () => {
    if (!error || spoken.current === error) return;
    spoken.current = error;
    window.clearTimeout(delayed);
    delayed = window.setTimeout(() => announce(`${label}: ${error}`), 500);
  };
}

export function Announcer() {
  const current = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => message,
    () => message,
  );
  return (
    <div
      aria-live="polite"
      aria-atomic="true"
      style={{
        position: "absolute",
        width: 1,
        height: 1,
        overflow: "hidden",
        clip: "rect(0 0 0 0)",
        whiteSpace: "nowrap",
      }}
    >
      {/* The id forces a repeated sentence to be read again. */}
      <span key={current.id}>{current.text}</span>
    </div>
  );
}

/**
 * After a success removes the focused control, keep keyboard users in the page instead of on the body.
 * It checks twice because a closing dialog returns focus to its (already removed) trigger a moment later.
 */
export function restoreFocus() {
  for (const delay of [0, 300])
    window.setTimeout(() => {
      const active = document.activeElement;
      if (!active || active === document.body)
        document.getElementById("content")?.focus({ preventScroll: true });
    }, delay);
}
