import { useSyncExternalStore } from "react";

// One persistent live region lets outcomes be announced even when the control that caused them unmounts.
let message = { text: "", id: 0 };
const listeners = new Set<() => void>();

export function announce(text: string) {
  message = { text, id: message.id + 1 };
  for (const listener of listeners) listener();
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

/** After a success removes the focused control, keep keyboard users in the page instead of on the body. */
export function restoreFocus() {
  window.setTimeout(() => {
    const active = document.activeElement;
    if (!active || active === document.body)
      document.getElementById("content")?.focus({ preventScroll: true });
  }, 0);
}
