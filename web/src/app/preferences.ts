export type Locale = "es" | "gl";
export type Theme = "light" | "dark";
export type ThemePreference = Theme | "system";
export function browserLocale(languages: readonly string[]): Locale {
  for (const language of languages) {
    const base = language.toLowerCase().split("-")[0];
    if (base === "gl" || base === "es") return base;
  }
  return "gl";
}
export function readVisitorPreferences(
  storage: Pick<Storage, "getItem"> | undefined,
  languages: readonly string[],
) {
  let value: { locale?: unknown; theme?: unknown } = {};
  try {
    value = JSON.parse(storage?.getItem("quenda.preferences") ?? "{}") ?? {};
  } catch {
    /* Storage can be unavailable in private browsing. */
  }
  return {
    locale:
      value.locale === "es" || value.locale === "gl"
        ? value.locale
        : browserLocale(languages),
    theme:
      value.theme === "light" ||
      value.theme === "dark" ||
      value.theme === "system"
        ? value.theme
        : null,
  } as { locale: Locale; theme: ThemePreference | null };
}
export function saveVisitorPreferences(
  storage: Pick<Storage, "setItem"> | undefined,
  value: { locale: Locale; theme: ThemePreference | null },
) {
  try {
    storage?.setItem("quenda.preferences", JSON.stringify(value));
  } catch {
    /* Preferences still work for this page. */
  }
}
