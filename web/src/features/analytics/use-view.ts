import { useCallback, useState } from "react";
import { browserStorage } from "../../app/storage.ts";
import {
  defaultView,
  parseView,
  type ViewPreferences,
  viewStorageKey,
} from "./model.ts";

function read(): ViewPreferences {
  try {
    return parseView(browserStorage("local")?.getItem(viewStorageKey));
  } catch {
    return defaultView;
  }
}

/**
 * Personal display choices for the analysis. They live only in this browser;
 * without storage the choices still apply until the page is left.
 */
export function useAnalyticsView() {
  const [view, setView] = useState(read);
  const update = useCallback((next: ViewPreferences) => {
    setView(next);
    try {
      browserStorage("local")?.setItem(viewStorageKey, JSON.stringify(next));
    } catch {
      /* Blocked storage keeps the choice for this visit only. */
    }
  }, []);
  const reset = useCallback(() => {
    setView(defaultView);
    try {
      browserStorage("local")?.removeItem(viewStorageKey);
    } catch {
      /* Nothing stored to remove. */
    }
  }, []);
  return { view, update, reset };
}
