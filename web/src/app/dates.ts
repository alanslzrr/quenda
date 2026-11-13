import { calendarLabel } from "../ui/lib/calendar-labels.ts";

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * A date in the reader's own time zone, written with the application's Spanish and Galician labels
 * ("13 de noviembre de 2026"). Browsers without Galician locale data would otherwise fall back to English.
 */
export function localDate(value: string | Date, locale: string) {
  return calendarLabel(new Date(value), locale, "long");
}

/** The same, followed by the time: "13 de noviembre de 2026 · 18:05". */
export function localDateTime(value: string | Date, locale: string) {
  const date = new Date(value);
  return `${localDate(date, locale)} · ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
