import type { Appearance } from "./api";
import type { Theme } from "./preferences";
export const defaultAppearance: Appearance = {
  version: 1,
  lightPalette: "neutral",
  darkPalette: "neutral",
  defaultTheme: "light",
};
// Fixed palettes keep semantic states and component colors out of municipal configuration.
export const paletteColors = {
  light: {
    neutral: {
      background: "#ffffff",
      surface: "#f6f6f6",
      text: "#242424",
      secondary: "#595959",
      accent: "#333333",
      onAccent: "#ffffff",
      border: "#767676",
    },
    blue: {
      background: "#f9fbff",
      surface: "#eef3fb",
      text: "#172638",
      secondary: "#43556b",
      accent: "#184faf",
      onAccent: "#ffffff",
      border: "#64748b",
    },
    green: {
      background: "#f9fcfa",
      surface: "#edf5ef",
      text: "#193126",
      secondary: "#415c4b",
      accent: "#196342",
      onAccent: "#ffffff",
      border: "#64796c",
    },
  },
  dark: {
    neutral: {
      background: "#191919",
      surface: "#242424",
      text: "#f5f5f5",
      secondary: "#b8b8b8",
      accent: "#dddddd",
      onAccent: "#191919",
      border: "#898989",
    },
    blue: {
      background: "#141d2b",
      surface: "#1c2a3e",
      text: "#f1f5fc",
      secondary: "#b3c4de",
      accent: "#aac9ff",
      onAccent: "#142b50",
      border: "#8195b4",
    },
    green: {
      background: "#15251d",
      surface: "#20352a",
      text: "#f0f8f3",
      secondary: "#b3cebd",
      accent: "#9adab6",
      onAccent: "#123922",
      border: "#829d8d",
    },
  },
} as const;
export function themeVariables(
  theme: Theme,
  appearance = defaultAppearance,
): Record<string, string> {
  const palette =
    paletteColors[theme][
      theme === "light" ? appearance.lightPalette : appearance.darkPalette
    ];
  return {
    "--background": palette.background,
    "--surface": palette.background,
    "--surface-raised": palette.surface,
    "--surface-muted": palette.surface,
    "--foreground": palette.text,
    "--text-secondary": palette.secondary,
    "--text-muted": palette.secondary,
    "--accent": palette.accent,
    "--accent-strong": palette.accent,
    "--accent-foreground": palette.onAccent,
    "--accent-subtle": `color-mix(in srgb, ${palette.accent} 12%, transparent)`,
    "--focus-outline": palette.accent,
    "--border-strong": palette.border,
  };
}
