/** The product speaks Galician and Spanish; any other locale falls back to English copy. */
export type UiLanguage = "gl" | "es" | "en";

export function uiLanguage(locale: string): UiLanguage {
  const tag = locale.trim().toLowerCase();
  return tag.startsWith("gl") ? "gl" : tag.startsWith("es") ? "es" : "en";
}

/** Picks the copy for the locale's language. */
export function pickText<T>(locale: string, text: Record<UiLanguage, T>): T {
  return text[uiLanguage(locale)];
}

/** Intl locale list: the requested locale first, then Spanish for an unsupported or empty tag. Galician is handled by `intl-cache.ts`. */
export function numberLocales(locale: string): string[] {
  const tag = locale.trim();
  return tag && tag !== "es-ES" ? [tag, "es-ES"] : ["es-ES"];
}

/** Shown wherever a value is missing; never a zero. */
export const MISSING_MARK = "—";

/** Spoken in place of a missing value. */
export const noDataText = (locale: string) =>
  pickText(locale, { gl: "sen datos", es: "sin datos", en: "no data" });
