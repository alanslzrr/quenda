/**
 * The base colours of every municipal theme. The web derives the full interface from these three colours per mode;
 * the server only needs them to check that a municipality's overrides still read well on top of them.
 * `web/src/app/themes.ts` holds the same values and a test keeps both in step.
 */
export interface ModeColors {
  background: string;
  foreground: string;
  accent: string;
}
export type ColorOverrides = Partial<ModeColors>;

export const themeBases = {
  neutral: {
    light: { background: "#ffffff", foreground: "#1f1f1f", accent: "#333333" },
    dark: { background: "#191919", foreground: "#f5f5f5", accent: "#dddddd" },
  },
  slate: {
    light: { background: "#f8fafc", foreground: "#0f172a", accent: "#334155" },
    dark: { background: "#0f172a", foreground: "#e2e8f0", accent: "#94a3b8" },
  },
  blue: {
    light: { background: "#f9fbff", foreground: "#172638", accent: "#184faf" },
    dark: { background: "#141d2b", foreground: "#f1f5fc", accent: "#aac9ff" },
  },
  atlantic: {
    light: { background: "#f6fbfb", foreground: "#11302f", accent: "#0f6e6a" },
    dark: { background: "#0f2222", foreground: "#e6f4f3", accent: "#5fd0c6" },
  },
  green: {
    light: { background: "#f9fcfa", foreground: "#193126", accent: "#196342" },
    dark: { background: "#15251d", foreground: "#f0f8f3", accent: "#9adab6" },
  },
  olive: {
    light: { background: "#fafaf3", foreground: "#2a2e1a", accent: "#56661c" },
    dark: { background: "#1c1e14", foreground: "#f2f3e6", accent: "#c2d27a" },
  },
  sand: {
    light: { background: "#fcf9f3", foreground: "#2f2617", accent: "#835500" },
    dark: { background: "#211b12", foreground: "#f6efe2", accent: "#e8b45a" },
  },
  terracotta: {
    light: { background: "#fdf8f5", foreground: "#3a1f16", accent: "#ad4327" },
    dark: { background: "#241612", foreground: "#fbece6", accent: "#f19a7c" },
  },
  vineyard: {
    light: { background: "#fcf7f8", foreground: "#35141f", accent: "#8e1f45" },
    dark: { background: "#22121a", foreground: "#f9e9ef", accent: "#f08db0" },
  },
  rose: {
    light: { background: "#fff8fb", foreground: "#3b1430", accent: "#a92d6a" },
    dark: { background: "#241320", foreground: "#fbe9f3", accent: "#f59ac8" },
  },
  lavender: {
    light: { background: "#faf8ff", foreground: "#261c45", accent: "#5b3cc4" },
    dark: { background: "#18142b", foreground: "#eee9fb", accent: "#b7a3ff" },
  },
  granite: {
    light: { background: "#f7f6f4", foreground: "#262421", accent: "#57534e" },
    dark: { background: "#1c1b19", foreground: "#f2f0ed", accent: "#c9c4bc" },
  },
  night: {
    light: { background: "#f7f8fc", foreground: "#141a33", accent: "#3346a8" },
    dark: { background: "#0b0f1f", foreground: "#e8ebf7", accent: "#ffc857" },
  },
  contrast: {
    light: { background: "#ffffff", foreground: "#000000", accent: "#0039b3" },
    dark: { background: "#000000", foreground: "#ffffff", accent: "#ffd400" },
  },
} as const satisfies Record<string, { light: ModeColors; dark: ModeColors }>;
export type ThemeId = keyof typeof themeBases;
export const themes = Object.keys(themeBases) as ThemeId[];
export const fonts = ["inter", "geist", "system", "serif"] as const;
export const corners = ["round", "soft", "square"] as const;
export const colorKeys = ["background", "foreground", "accent"] as const;
export const hexColor = /^#[0-9a-f]{6}$/;

function channel(value: number) {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
/** WCAG relative luminance of a `#rrggbb` colour. */
export function luminance(hex: string) {
  const n = Number.parseInt(hex.slice(1), 16);
  return (
    0.2126 * channel((n >> 16) & 255) +
    0.7152 * channel((n >> 8) & 255) +
    0.0722 * channel(n & 255)
  );
}
export function contrast(a: string, b: string) {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (high + 0.05) / (low + 0.05);
}

export type ColorProblem =
  | "TEXT_CONTRAST"
  | "ACCENT_CONTRAST"
  | "LIGHT_BACKGROUND"
  | "DARK_BACKGROUND";
/**
 * Why a mode's colours would not read well, or null when they do: body text needs 4.5:1 on the background, the
 * accent (buttons, links, focus) 3:1, and each mode keeps a background of its own kind so the fixed state colours
 * (success, warning, danger) and shadows still fit.
 */
export function colorProblem(
  mode: "light" | "dark",
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
export function resolveColors(
  theme: ThemeId,
  mode: "light" | "dark",
  overrides: ColorOverrides,
): ModeColors {
  return { ...themeBases[theme][mode], ...overrides };
}
