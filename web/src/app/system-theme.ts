import { useSyncExternalStore } from "react";
import type { Theme } from "./preferences";

const query = "(prefers-color-scheme: dark)";
function subscribe(notify: () => void) {
  const media = window.matchMedia(query);
  media.addEventListener("change", notify);
  return () => media.removeEventListener("change", notify);
}
function snapshot(): Theme {
  return window.matchMedia(query).matches ? "dark" : "light";
}
export function useSystemTheme(): Theme {
  return useSyncExternalStore(subscribe, snapshot, () => "light");
}
