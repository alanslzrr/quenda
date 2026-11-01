import {
  createContext,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useState,
} from "react";
import type { Appearance } from "./api";
import type { Theme } from "./preferences";
import { usePreferences } from "./preferences-provider";
import { defaultAppearance, themeVariables } from "./theme";

const ThemeContext = createContext<
  ((appearance: Appearance | null) => void) | null
>(null);
type Preview = { appearance: Appearance; mode: Theme };
const PreviewContext = createContext<
  ((preview: Preview | null) => void) | null
>(null);
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [appearance, setAppearance] = useState<Appearance | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const { theme } = usePreferences();
  // Preview is local to the mounted editor; it never writes account preferences.
  const current = preview?.appearance ?? appearance ?? defaultAppearance;
  const mode = preview?.mode ?? theme ?? current.defaultTheme;
  useLayoutEffect(() => {
    const root = document.documentElement;
    const swap = document.createElement("style");
    swap.textContent = "*,*::before,*::after{transition:none!important}";
    document.head.append(swap);
    root.dataset.theme = mode;
    if (preview) root.dataset.themePreview = "true";
    else delete root.dataset.themePreview;
    root.dataset.accent =
      mode === "light" ? current.lightPalette : current.darkPalette;
    for (const [key, value] of Object.entries(themeVariables(mode, current)))
      root.style.setProperty(key, value);
    // Commit the complete palette before restoring ordinary control transitions.
    void window.getComputedStyle(root).color;
    const frame = requestAnimationFrame(() => swap.remove());
    return () => {
      cancelAnimationFrame(frame);
      swap.remove();
    };
  }, [mode, current, preview]);
  return (
    <ThemeContext.Provider value={setAppearance}>
      <PreviewContext.Provider value={setPreview}>
        {children}
      </PreviewContext.Provider>
    </ThemeContext.Provider>
  );
}

export function useAppearancePreview(
  appearance: Appearance,
  mode: Theme | null,
) {
  const set = useContext(PreviewContext);
  useLayoutEffect(() => {
    set?.(mode ? { appearance, mode } : null);
    return () => set?.(null);
  }, [appearance, mode, set]);
}
export function useMunicipalTheme(appearance: Appearance | undefined) {
  const set = useContext(ThemeContext);
  useLayoutEffect(() => {
    set?.(appearance ?? null);
    return () => set?.(null);
  }, [appearance, set]);
}
