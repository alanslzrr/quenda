"use client";

import { useCallback, useState } from "react";
import { flushSync } from "react-dom";
import { pickText } from "./locale-text";

const messages = {
  checkbox: {
    gl: "Marca esta caixa para continuar",
    es: "Marca esta casilla para continuar",
    en: "Check this box to continue",
  },
  select: {
    gl: "Escolle unha opción",
    es: "Elige una opción",
    en: "Choose an option",
  },
};

/**
 * A required Radix checkbox or select is validated through a hidden native mirror inside its field. A failed submit
 * fires `invalid` on that mirror, which nobody can see; the field shows the error by its visible control instead, until
 * the value changes. Attach `ref` to the element that wraps the Radix root.
 */
export function useMirrorInvalid(kind: keyof typeof messages) {
  const [invalid, setInvalid] = useState(false);
  const ref = useCallback((field: HTMLElement | null) => {
    if (!field) return;
    const onInvalid = (event: Event) => {
      if ((event.target as Element).getAttribute("aria-hidden") !== "true")
        return;
      // Rendered at once, so the control already carries aria-invalid and its error when the form focuses it.
      flushSync(() => setInvalid(true));
    };
    // `invalid` does not bubble, so the field listens in the capture phase.
    field.addEventListener("invalid", onInvalid, true);
    return () => field.removeEventListener("invalid", onInvalid, true);
  }, []);
  // The page language is read only once the error shows, after the application has set it.
  const message = invalid
    ? pickText(document.documentElement.lang, messages[kind])
    : undefined;
  return { ref, message, clear: () => setInvalid(false) };
}
