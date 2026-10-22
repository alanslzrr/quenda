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
    root.dataset.theme = mode;
    root.dataset.accent =
      mode === "light" ? current.lightPalette : current.darkPalette;
    for (const [key, value] of Object.entries(themeVariables(mode, current)))
      root.style.setProperty(key, value);
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
