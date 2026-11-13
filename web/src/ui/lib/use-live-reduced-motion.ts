"use client";

import { useSyncExternalStore } from "react";

const query = "(prefers-reduced-motion: reduce)";
const current = () =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" &&
  window.matchMedia(query).matches;
const subscribe = (notify: () => void) => {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const media = window.matchMedia(query);
  if (typeof media.addEventListener === "function") {
    media.addEventListener("change", notify);
    return () => media.removeEventListener("change", notify);
  }
  if (typeof media.addListener === "function") {
    media.addListener(notify);
    return () => media.removeListener(notify);
  }
  return () => {};
};
const server = () => false;

/** Follow live system changes while retaining the server snapshot during hydration. */
export function useLiveReducedMotion() {
  return useSyncExternalStore(subscribe, current, server);
}
