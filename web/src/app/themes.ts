/**
 * The municipal theme catalog. Each theme gives three colours per mode (background, text, accent); every other
 * colour of the interface is derived from them in `theme.ts`. The server keeps the same base colours in
 * `src/modules/identity/themes.ts` to validate overrides, and a test keeps both lists identical.
 */
export interface ModeColors {
  background: string;
  foreground: string;
  accent: string;
}
export const themeCatalog = {
  neutral: {
    label: ["Neutro", "Neutro"],
    light: { background: "#ffffff", foreground: "#1f1f1f", accent: "#333333" },
    dark: { background: "#191919", foreground: "#f5f5f5", accent: "#dddddd" },
  },
  slate: {
    label: ["Pizarra", "Lousa"],
    light: { background: "#f8fafc", foreground: "#0f172a", accent: "#334155" },
    dark: { background: "#0f172a", foreground: "#e2e8f0", accent: "#94a3b8" },
  },
  blue: {
    label: ["Azul", "Azul"],
    light: { background: "#f9fbff", foreground: "#172638", accent: "#184faf" },
    dark: { background: "#141d2b", foreground: "#f1f5fc", accent: "#aac9ff" },
  },
  atlantic: {
    label: ["Atlántico", "Atlántico"],
    light: { background: "#f6fbfb", foreground: "#11302f", accent: "#0f6e6a" },
    dark: { background: "#0f2222", foreground: "#e6f4f3", accent: "#5fd0c6" },
  },
  green: {
    label: ["Verde", "Verde"],
    light: { background: "#f9fcfa", foreground: "#193126", accent: "#196342" },
    dark: { background: "#15251d", foreground: "#f0f8f3", accent: "#9adab6" },
  },
  olive: {
    label: ["Oliva", "Oliva"],
    light: { background: "#fafaf3", foreground: "#2a2e1a", accent: "#56661c" },
    dark: { background: "#1c1e14", foreground: "#f2f3e6", accent: "#c2d27a" },
  },
  sand: {
    label: ["Arena", "Area"],
    light: { background: "#fcf9f3", foreground: "#2f2617", accent: "#835500" },
    dark: { background: "#211b12", foreground: "#f6efe2", accent: "#e8b45a" },
  },
  terracotta: {
    label: ["Terracota", "Terracota"],
    light: { background: "#fdf8f5", foreground: "#3a1f16", accent: "#ad4327" },
    dark: { background: "#241612", foreground: "#fbece6", accent: "#f19a7c" },
  },
  vineyard: {
    label: ["Viñedo", "Viñedo"],
    light: { background: "#fcf7f8", foreground: "#35141f", accent: "#8e1f45" },
    dark: { background: "#22121a", foreground: "#f9e9ef", accent: "#f08db0" },
  },
  rose: {
    label: ["Rosa", "Rosa"],
    light: { background: "#fff8fb", foreground: "#3b1430", accent: "#a92d6a" },
    dark: { background: "#241320", foreground: "#fbe9f3", accent: "#f59ac8" },
  },
  lavender: {
    label: ["Lavanda", "Lavanda"],
    light: { background: "#faf8ff", foreground: "#261c45", accent: "#5b3cc4" },
    dark: { background: "#18142b", foreground: "#eee9fb", accent: "#b7a3ff" },
  },
  granite: {
    label: ["Granito", "Granito"],
    light: { background: "#f7f6f4", foreground: "#262421", accent: "#57534e" },
    dark: { background: "#1c1b19", foreground: "#f2f0ed", accent: "#c9c4bc" },
  },
  night: {
    label: ["Noche", "Noite"],
    light: { background: "#f7f8fc", foreground: "#141a33", accent: "#3346a8" },
    dark: { background: "#0b0f1f", foreground: "#e8ebf7", accent: "#ffc857" },
  },
  contrast: {
    label: ["Alto contraste", "Alto contraste"],
    light: { background: "#ffffff", foreground: "#000000", accent: "#0039b3" },
    dark: { background: "#000000", foreground: "#ffffff", accent: "#ffd400" },
  },
} as const satisfies Record<
  string,
  { label: readonly [string, string]; light: ModeColors; dark: ModeColors }
>;
export type ThemeId = keyof typeof themeCatalog;
export const themeIds = Object.keys(themeCatalog) as ThemeId[];
export const isThemeId = (value: unknown): value is ThemeId =>
  typeof value === "string" && Object.hasOwn(themeCatalog, value);

export const fontChoices = {
  inter: {
    label: ["Inter", "Inter"],
    body: 'var(--font-inter, "Inter Variable"), sans-serif',
    display: 'var(--font-geist, "Geist Variable"), sans-serif',
  },
  geist: {
    label: ["Geist", "Geist"],
    body: 'var(--font-geist, "Geist Variable"), sans-serif',
    display: 'var(--font-geist, "Geist Variable"), sans-serif',
  },
  system: {
    label: ["Del sistema", "Do sistema"],
    body: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    display: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  },
  serif: {
    label: ["Clásica", "Clásica"],
    body: '"Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, serif',
    display:
      '"Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, serif',
  },
} as const;
export type FontId = keyof typeof fontChoices;

export const cornerChoices = {
  round: {
    label: ["Redondeadas", "Arredondadas"],
    control: "1.125rem",
    panel: "1.625rem",
    surface: "2.125rem",
  },
  soft: {
    label: ["Suaves", "Suaves"],
    control: "0.625rem",
    panel: "0.875rem",
    surface: "1.125rem",
  },
  square: {
    label: ["Rectas", "Rectas"],
    control: "0.25rem",
    panel: "0.375rem",
    surface: "0.5rem",
  },
} as const;
export type CornerId = keyof typeof cornerChoices;
