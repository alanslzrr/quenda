import { useSyncExternalStore } from "react";

// Every capture exists as `name.webp` (light theme) and `name-oscuro.webp` (dark theme).
const files = import.meta.glob<string>("./media/*.webp", {
  eager: true,
  import: "default",
});
const urls = new Map(
  Object.entries(files).map(([file, url]) => [
    file.slice("./media/".length, -".webp".length),
    url,
  ]),
);

function subscribe(notify: () => void) {
  const observer = new MutationObserver(notify);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  return () => observer.disconnect();
}
const isDark = () => document.documentElement.dataset.theme === "dark";

/** The theme the page is drawn in, following the settings menu as it changes. */
export function useDarkTheme() {
  return useSyncExternalStore(subscribe, isDark, () => false);
}

/** The capture of a view in the theme the page is drawn in. */
export function useCapture() {
  const dark = useDarkTheme();
  return (name: string) => {
    const url = urls.get(dark ? `${name}-oscuro` : name) ?? urls.get(name);
    if (!url) throw new Error(`Missing capture ${name}`);
    return url;
  };
}
