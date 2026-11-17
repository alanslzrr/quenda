import { useEffect, useState } from "react";

// setTimeout overflows above 2^31 - 1 ms (about 24.8 days) and would fire at once; longer waits are taken in steps.
const longestDelay = 2_147_483_647;

/**
 * Re-renders once `now()` passes each boundary (milliseconds on the same clock), so a page whose
 * output changes only at a deadline sleeps until then instead of re-rendering every second.
 * Returning to the tab or focusing the window checks again, as timers stall while the device sleeps.
 */
export function useClockBoundaries(
  boundaries: readonly number[],
  now: () => number,
) {
  const [, setPassed] = useState(0);
  const key = boundaries.filter(Number.isFinite).join(",");
  useEffect(() => {
    const times = key ? key.split(",").map(Number) : [];
    if (!times.length) return;
    let timer = 0;
    const check = () => {
      window.clearTimeout(timer);
      const current = now();
      // React skips the render when the count is unchanged.
      setPassed(times.filter((time) => current > time).length);
      const next = Math.min(...times.filter((time) => time >= current));
      if (Number.isFinite(next))
        timer = window.setTimeout(
          check,
          Math.min(next - current + 1, longestDelay),
        );
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") check();
    };
    check();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", check);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", check);
    };
  }, [key, now]);
}
