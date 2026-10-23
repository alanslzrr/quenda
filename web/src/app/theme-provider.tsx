import {
  createContext,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useState,
} from "react";
import type { Appearance } from "./api";
import { usePreferences } from "./preferences-provider";
import { defaultAppearance, themeVariables } from "./theme";

const ThemeContext = createContext<
  ((appearance: Appearance | null) => void) | null
>(null);
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [appearance, setAppearance] = useState<Appearance | null>(null);
  const { theme } = usePreferences();
  const current = appearance ?? defaultAppearance;
  const mode = theme ?? current.defaultTheme;
  useLayoutEffect(() => {
    const root = document.documentElement;
    const swap = document.createElement("style");
    swap.textContent = "*,*::before,*::after{transition:none!important}";
    document.head.append(swap);
    root.dataset.theme = mode;
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
  }, [mode, current]);
  return (
    <ThemeContext.Provider value={setAppearance}>
      {children}
    </ThemeContext.Provider>
  );
}
export function useMunicipalTheme(appearance: Appearance | undefined) {
  const set = useContext(ThemeContext);
  useLayoutEffect(() => {
    set?.(appearance ?? null);
    return () => set?.(null);
  }, [appearance, set]);
}
