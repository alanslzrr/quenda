import type { Appearance, ColorOverrides } from "./api";
import type { Theme } from "./preferences";
import {
  cornerChoices,
  fontChoices,
  isThemeId,
  type ModeColors,
  themeCatalog,
} from "./themes.ts";

export const defaultAppearance: Appearance = {
  version: 1,
  theme: "neutral",
  light: {},
  dark: {},
  font: "inter",
  corners: "round",
  defaultTheme: "light",
};

const hex = /^#[0-9a-f]{6}$/;
function rgb(color: string) {
  const n = Number.parseInt(color.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255] as const;
}
/** `a` moved towards `b` by `amount` (0–1), in sRGB. */
export function mix(a: string, b: string, amount: number) {
  const [x, y] = [rgb(a), rgb(b)];
  return `#${x
    .map((value, n) =>
      Math.round(value + ((y[n] ?? 0) - value) * amount)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}
function channel(value: number) {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
export function luminance(color: string) {
  const [r, g, b] = rgb(color);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
export function contrast(a: string, b: string) {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (high + 0.05) / (low + 0.05);
}
/** Moves `color` towards `toward` until it reaches `minimum` contrast on every surface. */
function reach(
  color: string,
  surfaces: string[],
  minimum: number,
  toward: string,
) {
  for (let step = 0; step <= 50; step++) {
    const candidate = mix(color, toward, step / 50);
    if (surfaces.every((surface) => contrast(candidate, surface) >= minimum))
      return candidate;
  }
  return toward;
}

export type ColorProblem =
  | "TEXT_CONTRAST"
  | "ACCENT_CONTRAST"
  | "LIGHT_BACKGROUND"
  | "DARK_BACKGROUND";
/** The same rule the server applies before saving. */
export function colorProblem(
  mode: Theme,
  colors: ModeColors,
): ColorProblem | null {
  const background = luminance(colors.background);
  if (mode === "light" && background < 0.5) return "LIGHT_BACKGROUND";
  if (mode === "dark" && background > 0.06) return "DARK_BACKGROUND";
  if (contrast(colors.foreground, colors.background) < 4.5)
    return "TEXT_CONTRAST";
  if (contrast(colors.accent, colors.background) < 3) return "ACCENT_CONTRAST";
  return null;
}

/** The three colours a mode is drawn from: the theme's own, with the municipality's valid overrides on top. */
export function resolveColors(
  mode: Theme,
  appearance: Partial<Appearance> | null | undefined = defaultAppearance,
): ModeColors {
  const theme = isThemeId(appearance?.theme) ? appearance.theme : "neutral";
  const base = themeCatalog[theme][mode];
  const overrides: ColorOverrides = appearance?.[mode] ?? {};
  const pick = (key: keyof ModeColors) => {
    const value = overrides[key];
    return typeof value === "string" && hex.test(value) ? value : base[key];
  };
  const colors = {
    background: pick("background"),
    foreground: pick("foreground"),
    accent: pick("accent"),
  };
  // Overrides that would not read well (never saved by the server) fall back to the theme rather than hide text.
  return colorProblem(mode, colors) ? base : colors;
}

/**
 * Every colour token of the interface for one mode, derived from background, text and accent so that secondary
 * text, borders and controls keep their contrast whatever the municipality chose.
 */
export function deriveTokens(mode: Theme, colors: ModeColors) {
  const dark = mode === "dark";
  const { background, foreground, accent } = colors;
  const raised = dark ? mix(background, foreground, 0.05) : background;
  const muted = mix(background, foreground, dark ? 0.08 : 0.04);
  const surfaces = [background, raised, muted];
  // Derived text only ever moves towards the mode's extreme, so it reaches contrast even when the chosen text
  // colour sits right at the limit.
  const extreme = dark ? "#ffffff" : "#000000";
  const text = reach(foreground, surfaces, 4.5, extreme);
  const accentForeground =
    contrast(background, accent) >= contrast(foreground, accent)
      ? background
      : foreground;
  return {
    "--background": background,
    "--surface": background,
    "--surface-raised": raised,
    "--surface-muted": muted,
    "--foreground": text,
    "--text-secondary": reach(
      mix(text, background, 0.28),
      surfaces,
      4.5,
      extreme,
    ),
    "--text-muted": reach(mix(text, background, 0.4), surfaces, 4.5, extreme),
    "--border": mix(background, foreground, dark ? 0.14 : 0.08),
    "--border-subtle": mix(background, foreground, dark ? 0.09 : 0.045),
    "--border-strong": reach(mix(background, text, 0.4), surfaces, 3, extreme),
    "--accent": accent,
    "--accent-strong": reach(mix(accent, text, 0.2), surfaces, 4.5, extreme),
    "--accent-subtle": `${accent}${dark ? "26" : "1a"}`,
    "--accent-foreground": accentForeground,
    "--focus-outline": accent,
    "--control-on": accent,
    "--control-glyph": accentForeground,
    "--control-thumb-on": accentForeground,
    "--control-fill": accent,
    "--control-track": mix(background, foreground, dark ? 0.2 : 0.13),
    "--control-track-hover": mix(background, foreground, dark ? 0.26 : 0.18),
    "--control-thumb": dark ? mix(foreground, background, 0.04) : "#ffffff",
  };
}

export function themeVariables(
  mode: Theme,
  appearance: Partial<Appearance> | null | undefined = defaultAppearance,
): Record<string, string> {
  const font =
    fontChoices[
      appearance?.font && Object.hasOwn(fontChoices, appearance.font)
        ? appearance.font
        : "inter"
    ];
  const corners =
    cornerChoices[
      appearance?.corners && Object.hasOwn(cornerChoices, appearance.corners)
        ? appearance.corners
        : "round"
    ];
  return {
    ...deriveTokens(mode, resolveColors(mode, appearance)),
    "--font-body": font.body,
    "--font-display": font.display,
    "--radius-control": corners.control,
    "--radius-panel": corners.panel,
    "--radius-surface": corners.surface,
  };
}
