import { useSyncExternalStore } from "react";
import { browserStorage } from "./storage.ts";

const key = "quenda.municipality";
const changed = "quenda:favorite";

export function readFavorite(
  storage: Pick<Storage, "getItem"> | undefined,
): string | null {
  try {
    const value = storage?.getItem(key) ?? null;
    return value &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        value,
      )
      ? value
      : null;
  } catch {
    return null;
  }
}

export function saveFavorite(
  storage: Pick<Storage, "setItem" | "removeItem"> | undefined,
  tenantId: string | null,
) {
  try {
    if (tenantId) storage?.setItem(key, tenantId);
    else storage?.removeItem(key);
  } catch {
    /* Storage can be unavailable in private browsing. */
  }
}

function subscribe(notify: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === key) notify();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(changed, notify);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(changed, notify);
  };
}

/** The favourite municipality lives only in this browser; it is a starting point, never a permission. */
export function useFavorite() {
  const favorite = useSyncExternalStore(
    subscribe,
    () => readFavorite(browserStorage("local")),
    () => null,
  );
  const setFavorite = (tenantId: string | null) => {
    saveFavorite(browserStorage("local"), tenantId);
    window.dispatchEvent(new Event(changed));
  };
  return [favorite, setFavorite] as const;
}
