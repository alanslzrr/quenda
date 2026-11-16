import { calendarLabel } from "../lib/calendar-labels.ts";
import { dateTimeFormat } from "../lib/intl-cache.ts";
import { pickText, uiLanguage } from "../lib/locale-text.ts";

/** An inclusive range of whole days. */
export interface DateRange {
  start: Date;
  end: Date;
}

const sameYear = (a: Date, b: Date) => a.getFullYear() === b.getFullYear();
const sameMonth = (a: Date, b: Date) => sameYear(a, b) && a.getMonth() === b.getMonth();
const sameDay = (a: Date, b: Date) => sameMonth(a, b) && a.getDate() === b.getDate();

/** The month word from the explicit Galician and Spanish names, so browsers without Galician data still read correctly. */
function monthWord(date: Date, locale: string) {
  const text = calendarLabel(new Date(date.getFullYear(), date.getMonth(), 1), locale, "month");
  return text.slice(0, text.lastIndexOf(" "));
}

/** Compact range for the trigger and the panel footer: "3 mar 2026", "3–9 mar 2026", "28 feb – 3 mar 2026". */
export function formatRangeShort(range: DateRange, locale: string): string {
  const { start, end } = range;
  if (uiLanguage(locale) === "en") {
    const format = dateTimeFormat(locale, { month: "short", day: "numeric", year: "numeric" });
    return sameDay(start, end) ? format.format(start) : format.formatRange(start, end);
  }
  const month = (date: Date) => monthWord(date, locale).slice(0, 3);
  const day = (date: Date) => `${date.getDate()} ${month(date)}`;
  const full = (date: Date) => `${day(date)} ${date.getFullYear()}`;
  if (sameDay(start, end)) return full(start);
  if (sameMonth(start, end)) return `${start.getDate()}–${full(end)}`;
  if (sameYear(start, end)) return `${day(start)} – ${full(end)}`;
  return `${full(start)} – ${full(end)}`;
}

/** Spoken range for assistive technology, with full month names and words instead of a dash. */
export function formatRangeSpoken(range: DateRange, locale: string): string {
  const { start, end } = range;
  const language = uiLanguage(locale);
  if (language === "en") {
    const format = dateTimeFormat(locale, { dateStyle: "long" });
    return sameDay(start, end) ? format.format(start) : format.formatRange(start, end);
  }
  const long = (date: Date) => calendarLabel(date, locale, "long");
  if (sameDay(start, end)) return long(start);
  const [from, to] = language === "gl" ? ["do", "ao"] : ["del", "al"];
  const tail = long(end);
  if (sameMonth(start, end)) return `${from} ${start.getDate()} ${to} ${tail}`;
  if (sameYear(start, end)) return `${from} ${start.getDate()} de ${monthWord(start, locale)} ${to} ${tail}`;
  return `${from} ${long(start)} ${to} ${tail}`;
}

/** Every string the picker writes itself. The caller supplies only the presets and, optionally, the label and placeholder. */
export function dateRangeText(locale: string) {
  const text = <T,>(gl: T, es: T, en: T) => pickText(locale, { gl, es, en });
  return {
    label: text("Intervalo de datas", "Intervalo de fechas", "Date range"),
    placeholder: text("Escolle as datas", "Elige las fechas", "Select dates"),
    presets: text("Períodos rápidos", "Periodos rápidos", "Presets"),
    previousMonth: text("Mes anterior", "Mes anterior", "Previous month"),
    nextMonth: text("Mes seguinte", "Mes siguiente", "Next month"),
    cancel: text("Cancelar", "Cancelar", "Cancel"),
    apply: text("Aplicar", "Aplicar", "Apply"),
    noDates: text("Sen datas", "Sin fechas", "No dates"),
    pickEnd: text("Escolle a data final", "Elige la fecha final", "Pick an end date"),
    startChosen: (day: string) =>
      text(`Inicio: ${day}. Escolle a data final.`, `Inicio: ${day}. Elige la fecha final.`, `Start ${day}. Choose an end date.`),
    days: (count: number) =>
      text(`${count} ${count === 1 ? "día" : "días"}`, `${count} ${count === 1 ? "día" : "días"}`, `${count} ${count === 1 ? "day" : "days"}`),
    monthTitle: (month: Date) => calendarLabel(month, locale, "month"),
    weekdayShort: (date: Date) => calendarLabel(date, locale, "weekday").slice(0, 2),
    weekdayLong: (date: Date) => calendarLabel(date, locale, "weekdayLong"),
    day: (date: Date) => calendarLabel(date, locale, "full"),
  };
}
