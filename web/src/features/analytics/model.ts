import { calendarLabel } from "../../ui/lib/calendar-labels.ts";

export type Language = "es" | "gl";
/** Spanish and Galician text, in that order, as `usePreferences().t` expects. */
export type Translate = (es: string, gl: string) => string;

export type Granularity = "day" | "week" | "month";
export type DefaultPeriod =
  | "THIS_WEEK"
  | "THIS_MONTH"
  | "LAST_MONTH"
  | "LAST_30_DAYS";

export interface AnalyticsSettings {
  version: number;
  highDemandPercent: number;
  lowUsePercent: number;
  defaultPeriod: DefaultPeriod;
}
export interface ReportUnit {
  unitId: string;
  name: string;
  facilityId: string;
  facilityName: string;
  withdrawn: boolean;
}
export interface SeriesSlot {
  from: string;
  to: string;
  offeredMinutes: number;
  reservedMinutes: number;
  occupancyPercent: number | null;
  reservations: number;
  cancelled: number;
}
export interface UnitUsage {
  unitId: string;
  name: string | null;
  facilityId: string | null;
  facilityName: string | null;
  offeredMinutes: number;
  reservedMinutes: number;
  occupancyPercent: number | null;
  reservations: number;
  cancelled: number;
  trend: (number | null)[];
}
export interface WeekdayHour {
  weekday: number;
  hour: number;
  offeredMinutes: number;
  reservedMinutes: number;
  occupancyPercent: number | null;
}
export interface UsageAnalytics {
  tenantId: string;
  unitId: string | null;
  from: string;
  to: string;
  timeZone: string;
  asOf: string;
  granularity: Granularity;
  summary: {
    reservations: { CONFIRMADA: number; CANCELADA: number; FINALIZADA: number };
    reservedMinutes: number;
    offeredMinutes: number;
    occupancyPercent: number | null;
  };
  series: SeriesSlot[];
  weekdayHours: WeekdayHour[];
  units: UnitUsage[];
  cancellations: {
    reservations: number;
    cancelled: number;
    byHolder: number;
    administrative: number;
    cancelledPercent: number | null;
  };
  leadTime: {
    lessThanOneDay: number;
    oneToThreeDays: number;
    threeToSevenDays: number;
    sevenToFourteenDays: number;
    fourteenDaysOrMore: number;
  };
  attendance: {
    finished: number;
    arrived: number;
    arrivedPercent: number | null;
  };
}

/* ---------- Civil dates: "YYYY-MM-DD" strings with UTC arithmetic ---------- */

const civil = (value: string) => new Date(`${value}T00:00:00Z`);
const iso = (date: Date) => date.toISOString().slice(0, 10);
export function addDays(value: string, days: number) {
  const date = civil(value);
  date.setUTCDate(date.getUTCDate() + days);
  return iso(date);
}
export function daysBetween(from: string, to: string) {
  return Math.round((civil(to).getTime() - civil(from).getTime()) / 86400000);
}
const monthStart = (value: string) => `${value.slice(0, 7)}-01`;
function addMonths(value: string, months: number) {
  const date = civil(monthStart(value));
  date.setUTCMonth(date.getUTCMonth() + months);
  return iso(date);
}
/** A Date for calendar labels; only its local year, month and day are read. */
export const labelDate = (value: string) => {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1);
};
export const isCivilDate = (value: string | null): value is string =>
  !!value &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(civil(value).getTime()) &&
  iso(civil(value)) === value;

/** A period of whole local days. `to` is the first day after it, as the API expects. */
export interface Period {
  from: string;
  to: string;
}
/**
 * Presets end today, so a period never mixes what happened with what is only
 * booked for later; "last month" is the whole previous calendar month.
 */
export function presetPeriod(preset: DefaultPeriod, today: string): Period {
  const tomorrow = addDays(today, 1);
  switch (preset) {
    case "THIS_WEEK": {
      const weekday = (civil(today).getUTCDay() + 6) % 7;
      return { from: addDays(today, -weekday), to: tomorrow };
    }
    case "THIS_MONTH":
      return { from: monthStart(today), to: tomorrow };
    case "LAST_MONTH":
      return { from: addMonths(today, -1), to: monthStart(today) };
    case "LAST_30_DAYS":
      return { from: addDays(today, -29), to: tomorrow };
  }
}
export const presetOrder: DefaultPeriod[] = [
  "THIS_WEEK",
  "THIS_MONTH",
  "LAST_MONTH",
  "LAST_30_DAYS",
];
export function presetLabel(preset: DefaultPeriod, t: Translate) {
  return {
    THIS_WEEK: t("Esta semana", "Esta semana"),
    THIS_MONTH: t("Este mes", "Este mes"),
    LAST_MONTH: t("Mes pasado", "Mes pasado"),
    LAST_30_DAYS: t("Últimos 30 días", "Últimos 30 días"),
  }[preset];
}
export function validPeriod(period: Period) {
  if (!isCivilDate(period.from) || !isCivilDate(period.to)) return false;
  const days = daysBetween(period.from, period.to);
  return days >= 1 && days <= 366;
}
const wholeMonths = (period: Period) =>
  period.from === monthStart(period.from) &&
  period.to === monthStart(period.to) &&
  period.to > period.from;
/**
 * The period to compare with: the same calendar months just before when the
 * period is made of whole months, otherwise the same number of days just before.
 */
export function previousPeriod(period: Period): Period & {
  kind: "months" | "days";
} {
  if (wholeMonths(period)) {
    const months =
      (Number(period.to.slice(0, 4)) - Number(period.from.slice(0, 4))) * 12 +
      Number(period.to.slice(5, 7)) -
      Number(period.from.slice(5, 7));
    return {
      from: addMonths(period.from, -months),
      to: period.from,
      kind: "months",
    };
  }
  const days = daysBetween(period.from, period.to);
  return { from: addDays(period.from, -days), to: period.from, kind: "days" };
}
/** "frente a octubre", "frente a los 12 días anteriores". */
export function comparisonName(period: Period, t: Translate) {
  const previous = previousPeriod(period);
  if (previous.kind === "months") {
    const months = Math.round(daysBetween(previous.from, previous.to) / 30.4);
    if (months > 1)
      return t(
        `frente a los ${months} meses anteriores`,
        `fronte aos ${months} meses anteriores`,
      );
    const sameYear = previous.from.slice(0, 4) === period.from.slice(0, 4);
    const month = (language: Language) => {
      const label = calendarLabel(labelDate(previous.from), language, "month");
      return sameYear ? label.replace(/ \d{4}$/, "") : label;
    };
    return t(`frente a ${month("es")}`, `fronte a ${month("gl")}`);
  }
  const days = daysBetween(previous.from, previous.to);
  return days === 1
    ? t("frente al día anterior", "fronte ao día anterior")
    : t(
        `frente a los ${days} días anteriores`,
        `fronte aos ${days} días anteriores`,
      );
}
/** "del 3 al 9 de noviembre de 2026", with the inclusive last day. */
export function periodName(period: Period, locale: Language) {
  const last = addDays(period.to, -1);
  const date = (value: string) =>
    calendarLabel(labelDate(value), locale, "long");
  if (last === period.from) return date(last);
  const of = locale === "gl" ? "do" : "del";
  const to = locale === "gl" ? "ao" : "al";
  if (period.from.slice(0, 7) === last.slice(0, 7)) {
    const tail = date(last);
    return `${of} ${Number(period.from.slice(8))} ${to} ${tail}`;
  }
  return `${of} ${date(period.from)} ${to} ${date(last)}`;
}

/* ---------- Numbers ---------- */

export const languageTag = (locale: Language) =>
  locale === "gl" ? ["gl-ES", "es-ES"] : ["es-ES"];
export function formatNumber(value: number, locale: Language, digits = 0) {
  return new Intl.NumberFormat(languageTag(locale), {
    maximumFractionDigits: digits,
    minimumFractionDigits: 0,
  }).format(value);
}
export const hours = (minutes: number) => minutes / 60;
/** One decimal below ten, whole numbers above, so small values keep meaning. */
export function formatHours(minutes: number, locale: Language) {
  const value = hours(minutes);
  return formatNumber(value, locale, value < 10 ? 1 : 0);
}
export function formatPercent(value: number | null, locale: Language) {
  return value === null ? "—" : `${formatNumber(value, locale, 0)} %`;
}

/* ---------- Comparison with the previous period ---------- */

export interface Comparison {
  text: string;
  direction: "up" | "down" | "flat";
  tone: "positive" | "negative" | "neutral";
}
/**
 * Change against the previous period. Rates compare in percentage points,
 * amounts in relative terms; `lowerIsBetter` turns a decrease into good news.
 */
export function compare(
  current: number | null,
  previous: number | null | undefined,
  kind: "points" | "relative",
  t: Translate,
  locale: Language,
  lowerIsBetter = false,
): Comparison | undefined {
  if (current === null || previous === null || previous === undefined)
    return undefined;
  let change: number;
  let text: string;
  if (kind === "points") {
    change = Math.round(current - previous);
    const amount = formatNumber(Math.abs(change), locale);
    text =
      change === 0
        ? t("Sin cambios", "Sen cambios")
        : Math.abs(change) === 1
          ? t(`${amount} punto`, `${amount} punto`)
          : t(`${amount} puntos`, `${amount} puntos`);
  } else {
    if (previous === 0)
      return current === 0
        ? {
            text: t("Sin cambios", "Sen cambios"),
            direction: "flat",
            tone: "neutral",
          }
        : { text: t("Nuevo", "Novo"), direction: "up", tone: "neutral" };
    change = Math.round(((current - previous) / previous) * 100);
    text =
      change === 0
        ? t("Sin cambios", "Sen cambios")
        : `${formatNumber(Math.abs(change), locale)} %`;
  }
  const direction = change > 0 ? "up" : change < 0 ? "down" : "flat";
  const better = lowerIsBetter ? direction === "down" : direction === "up";
  return {
    text,
    direction,
    tone: direction === "flat" ? "neutral" : better ? "positive" : "negative",
  };
}

/* ---------- Demand labels and highlights ---------- */

export type Demand = "high" | "low" | null;
export function demand(
  occupancy: number | null,
  settings: Pick<AnalyticsSettings, "highDemandPercent" | "lowUsePercent">,
): Demand {
  if (occupancy === null) return null;
  if (occupancy >= settings.highDemandPercent) return "high";
  if (occupancy < settings.lowUsePercent) return "low";
  return null;
}
export const weekdayNames = {
  es: [
    "lunes",
    "martes",
    "miércoles",
    "jueves",
    "viernes",
    "sábado",
    "domingo",
  ],
  gl: ["luns", "martes", "mércores", "xoves", "venres", "sábado", "domingo"],
} as const;
const clock = (hour: number) => `${String(hour % 24).padStart(2, "0")}:00`;

/**
 * Demand is read by service day, from 06:00 to 05:59: the hours after midnight belong to the night before, so a Friday
 * booking that runs past midnight stays on Friday. `slot` counts hours from that day's midnight (24 and up are the
 * small hours of the next calendar day).
 */
export const serviceDayStart = 6;
export interface ServiceCell extends WeekdayHour {
  /** Service day, 1 (Monday) to 7 (Sunday). */
  day: number;
  /** 6–29: 24 is 00:00 of the following calendar day. */
  slot: number;
}
export function serviceCells(cells: WeekdayHour[]): ServiceCell[] {
  return cells.map((cell) =>
    cell.hour < serviceDayStart
      ? {
          ...cell,
          day: cell.weekday === 1 ? 7 : cell.weekday - 1,
          slot: cell.hour + 24,
        }
      : { ...cell, day: cell.weekday, slot: cell.hour },
  );
}
export const slotClock = (slot: number) => clock(slot);
/** Columns from the first to the last hour with opening hours or bookings, never before 06:00. */
export function serviceSlots(cells: ServiceCell[]) {
  const used = cells
    .filter((cell) => cell.offeredMinutes > 0 || cell.reservedMinutes > 0)
    .map((cell) => cell.slot);
  if (!used.length) return [];
  const first = Math.min(...used);
  return Array.from(
    { length: Math.max(...used) - first + 1 },
    (_, n) => first + n,
  );
}

/**
 * Hours that were barely open, such as a booking that runs past closing time or a one-off late opening, would win
 * at 100 % with a single booking. Only hours open at least half as long as the typical open hour can be the peak.
 */
function representative<T extends WeekdayHour>(cells: T[]) {
  const offered = cells.filter(
    (cell) => cell.offeredMinutes > 0 && cell.occupancyPercent !== null,
  );
  const minutes = offered
    .map((cell) => cell.offeredMinutes)
    .sort((a, b) => a - b);
  const median = minutes[Math.floor((minutes.length - 1) / 2)] ?? 0;
  return offered.filter((cell) => cell.offeredMinutes >= median / 2);
}

/**
 * The busiest stretch of the week: the representative hour with the highest occupancy and the neighbouring hours of
 * the same service day within five points of it. `start` and `end` are service-day slots.
 */
export function peak(cells: WeekdayHour[]) {
  const offered = representative(serviceCells(cells));
  const best = offered.reduce<ServiceCell | undefined>(
    (top, cell) =>
      !top || (cell.occupancyPercent ?? 0) > (top.occupancyPercent ?? 0)
        ? cell
        : top,
    undefined,
  );
  if (!best?.occupancyPercent) return undefined;
  const near = (slot: number) => {
    const cell = offered.find((c) => c.day === best.day && c.slot === slot);
    return (
      !!cell && (cell.occupancyPercent ?? 0) >= (best.occupancyPercent ?? 0) - 5
    );
  };
  let start = best.slot,
    end = best.slot + 1;
  while (start > serviceDayStart && near(start - 1)) start--;
  while (end < serviceDayStart + 24 && near(end)) end++;
  return {
    weekday: best.day,
    start,
    end,
    occupancyPercent: best.occupancyPercent,
  };
}
export function peakText(cells: WeekdayHour[], t: Translate, locale: Language) {
  const top = peak(cells);
  if (!top) return undefined;
  const day = weekdayNames[locale][top.weekday - 1] ?? "";
  const percent = formatPercent(top.occupancyPercent, locale);
  const from = clock(top.start),
    to = clock(top.end);
  return top.start >= 24
    ? t(
        `La franja con más demanda es la noche del ${day}, de ${from} a ${to} (${percent}).`,
        `A franxa con máis demanda é a noite do ${day}, de ${from} a ${to} (${percent}).`,
      )
    : t(
        `La franja con más demanda es el ${day} de ${from} a ${to} (${percent}).`,
        `A franxa con máis demanda é o ${day} de ${from} a ${to} (${percent}).`,
      );
}

/** One service day in a sentence's worth of numbers, for the day's summary in the demand table. */
export function daySummary(cells: ServiceCell[], day: number) {
  const own = cells.filter((cell) => cell.day === day);
  const offeredMinutes = own.reduce(
    (sum, cell) => sum + cell.offeredMinutes,
    0,
  );
  const reservedMinutes = own.reduce(
    (sum, cell) => sum + cell.reservedMinutes,
    0,
  );
  const busiest = representative(own).reduce<ServiceCell | undefined>(
    (top, cell) =>
      !top || (cell.occupancyPercent ?? 0) > (top.occupancyPercent ?? 0)
        ? cell
        : top,
    undefined,
  );
  return {
    offeredMinutes,
    reservedMinutes,
    occupancyPercent:
      offeredMinutes > 0
        ? Math.round((reservedMinutes / offeredMinutes) * 100)
        : null,
    busiest: busiest?.occupancyPercent ? busiest : undefined,
  };
}
export const unitName = (unit: Pick<UnitUsage, "name" | "facilityName">) =>
  [unit.name ?? "", unit.facilityName ?? ""].filter(Boolean).join(" · ");

/** Up to four plain sentences that summarise the period before any chart. */
export function highlights(input: {
  current: UsageAnalytics;
  previous?: UsageAnalytics | undefined;
  comparison: string;
  settings: Pick<AnalyticsSettings, "highDemandPercent" | "lowUsePercent">;
  t: Translate;
  locale: Language;
}) {
  const { current, previous, settings, t, locale } = input;
  const lines: string[] = [];
  const counted = current.cancellations.reservations;
  if (current.summary.offeredMinutes === 0 && counted === 0)
    return [
      t(
        "No hubo horario ofertado ni reservas en este periodo.",
        "Non houbo horario ofertado nin reservas neste período.",
      ),
    ];
  const now = current.summary.occupancyPercent;
  const before = previous?.summary.occupancyPercent ?? null;
  if (now !== null) {
    const value = formatPercent(now, locale);
    if (before === null)
      lines.push(
        t(`La ocupación fue del ${value}.`, `A ocupación foi do ${value}.`),
      );
    else {
      const old = formatPercent(before, locale);
      const change = Math.round(now) - Math.round(before);
      lines.push(
        change > 0
          ? t(
              `La ocupación subió del ${old} al ${value} ${input.comparison}.`,
              `A ocupación subiu do ${old} ao ${value} ${input.comparison}.`,
            )
          : change < 0
            ? t(
                `La ocupación bajó del ${old} al ${value} ${input.comparison}.`,
                `A ocupación baixou do ${old} ao ${value} ${input.comparison}.`,
              )
            : t(
                `La ocupación se mantuvo en el ${value} ${input.comparison}.`,
                `A ocupación mantívose no ${value} ${input.comparison}.`,
              ),
      );
    }
  }
  if (current.units.length > 1) {
    const ranked = current.units
      .filter((unit) => unit.occupancyPercent !== null)
      .sort((a, b) => (b.occupancyPercent ?? 0) - (a.occupancyPercent ?? 0));
    const top = ranked[0];
    if (top && (top.occupancyPercent ?? 0) > 0)
      lines.push(
        t(
          `El espacio con más demanda es «${unitName(top)}» (${formatPercent(top.occupancyPercent, locale)}).`,
          `O espazo con máis demanda é «${unitName(top)}» (${formatPercent(top.occupancyPercent, locale)}).`,
        ),
      );
    const low = ranked.filter(
      (unit) => demand(unit.occupancyPercent, settings) === "low",
    ).length;
    if (low > 0) {
      const limit = `${settings.lowUsePercent} %`;
      lines.push(
        low === 1
          ? t(
              `1 espacio tuvo poco uso (menos del ${limit}).`,
              `1 espazo tivo pouco uso (menos do ${limit}).`,
            )
          : t(
              `${low} espacios tuvieron poco uso (menos del ${limit}).`,
              `${low} espazos tiveron pouco uso (menos do ${limit}).`,
            ),
      );
    }
  }
  const busiest = peakText(current.weekdayHours, t, locale);
  if (busiest) lines.push(busiest);
  if (now === null)
    lines.push(
      t(
        "No hubo horario ofertado en este periodo, así que la ocupación no se puede calcular.",
        "Non houbo horario ofertado neste período, así que a ocupación non se pode calcular.",
      ),
    );
  const earlier = previous?.cancellations.reservations;
  const amount = formatNumber(counted, locale);
  lines.push(
    counted === 0
      ? t(
          "Ninguna reserva empezó en este periodo.",
          "Ningunha reserva comezou neste período.",
        )
      : earlier === undefined
        ? counted === 1
          ? t(
              "1 reserva empezó en este periodo.",
              "1 reserva comezou neste período.",
            )
          : t(
              `${amount} reservas empezaron en este periodo.`,
              `${amount} reservas comezaron neste período.`,
            )
        : counted === 1
          ? t(
              `1 reserva empezó en este periodo (${formatNumber(earlier, locale)} ${input.comparison}).`,
              `1 reserva comezou neste período (${formatNumber(earlier, locale)} ${input.comparison}).`,
            )
          : t(
              `${amount} reservas empezaron en este periodo (${formatNumber(earlier, locale)} ${input.comparison}).`,
              `${amount} reservas comezaron neste período (${formatNumber(earlier, locale)} ${input.comparison}).`,
            ),
  );
  return lines.slice(0, 4);
}

/* ---------- Series labels ---------- */

export function slotLabels(
  slot: Pick<SeriesSlot, "from" | "to">,
  granularity: Granularity,
  locale: Language,
) {
  const start = labelDate(slot.from);
  const short = (value: string) =>
    `${Number(value.slice(8))} ${calendarLabel(labelDate(value), locale, "month").slice(0, 3)}`;
  if (granularity === "day")
    return {
      label: calendarLabel(start, locale, "day"),
      axisLabel: short(slot.from),
    };
  if (granularity === "week") {
    const last = addDays(slot.to, -1);
    return {
      label: `${periodName(slot, locale)}`,
      axisLabel:
        slot.from === last
          ? short(slot.from)
          : `${short(slot.from)}–${short(last)}`,
    };
  }
  const month = calendarLabel(start, locale, "month");
  return {
    label:
      slot.from === monthStart(slot.from) && slot.to === addMonths(slot.from, 1)
        ? month
        : periodName(slot, locale),
    axisLabel: month.slice(0, 3),
  };
}

/* ---------- Personal view, stored only in this browser ---------- */

export const viewStorageKey = "quenda.analytics-view";
export interface ViewPreferences {
  evolution: "line" | "bars";
  granularity: "auto" | Granularity;
  previous: boolean;
  demandMetric: "percent" | "hours";
  blocks: { evolution: boolean; demand: boolean; compliance: boolean };
  display: "chart" | "table";
}
export const defaultView: ViewPreferences = {
  evolution: "line",
  granularity: "auto",
  previous: true,
  demandMetric: "percent",
  blocks: { evolution: true, demand: true, compliance: true },
  display: "chart",
};
const pick = <T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
) => (allowed.includes(value as T) ? (value as T) : fallback);
const flag = (value: unknown, fallback: boolean) =>
  typeof value === "boolean" ? value : fallback;
/** Only known choices survive; anything else falls back to the default view. */
export function parseView(raw: string | null | undefined): ViewPreferences {
  let value: Record<string, unknown> = {};
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      value = parsed as Record<string, unknown>;
  } catch {
    value = {};
  }
  const blocks =
    value.blocks && typeof value.blocks === "object"
      ? (value.blocks as Record<string, unknown>)
      : {};
  return {
    evolution: pick(value.evolution, ["line", "bars"], defaultView.evolution),
    granularity: pick(
      value.granularity,
      ["auto", "day", "week", "month"],
      defaultView.granularity,
    ),
    previous: flag(value.previous, defaultView.previous),
    demandMetric: pick(
      value.demandMetric,
      ["percent", "hours"],
      defaultView.demandMetric,
    ),
    blocks: {
      evolution: flag(blocks.evolution, true),
      demand: flag(blocks.demand, true),
      compliance: flag(blocks.compliance, true),
    },
    display: pick(value.display, ["chart", "table"], defaultView.display),
  };
}

/* ---------- Spreadsheet of what the screen shows ---------- */

const formulaStart = /^[=+\-@\t\r]/;
function cell(value: string | number | null) {
  if (value === null) return "";
  let text = String(value);
  if (typeof value === "string" && formulaStart.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
const round = (value: number | null, digits = 2) =>
  value === null ? null : Number(value.toFixed(digits));
/**
 * The aggregates on screen as one comma-separated sheet: totals, the series and
 * one row per space. Numbers keep a dot as decimal separator.
 */
export function analyticsCsv(data: UsageAnalytics, t: Translate) {
  const rows: (string | number | null)[][] = [
    [
      t("Sección", "Sección"),
      t("Desde", "Desde"),
      t("Hasta (excluido)", "Ata (excluído)"),
      t("Elemento", "Elemento"),
      t("Instalación", "Instalación"),
      t("Horas ofertadas", "Horas ofertadas"),
      t("Horas reservadas", "Horas reservadas"),
      t("Ocupación (%)", "Ocupación (%)"),
      t("Reservas", "Reservas"),
      t("Canceladas", "Canceladas"),
    ],
    [
      t("Total", "Total"),
      data.from,
      data.to,
      null,
      null,
      round(hours(data.summary.offeredMinutes)),
      round(hours(data.summary.reservedMinutes)),
      round(data.summary.occupancyPercent),
      data.cancellations.reservations,
      data.cancellations.cancelled,
    ],
    ...data.series.map((slot) => [
      t("Evolución", "Evolución"),
      slot.from,
      slot.to,
      null,
      null,
      round(hours(slot.offeredMinutes)),
      round(hours(slot.reservedMinutes)),
      round(slot.occupancyPercent),
      slot.reservations,
      slot.cancelled,
    ]),
    ...data.units.map((unit) => [
      t("Espacio", "Espazo"),
      data.from,
      data.to,
      unit.name ?? unit.unitId,
      unit.facilityName,
      round(hours(unit.offeredMinutes)),
      round(hours(unit.reservedMinutes)),
      round(unit.occupancyPercent),
      unit.reservations,
      unit.cancelled,
    ]),
  ];
  return `${rows.map((row) => row.map(cell).join(",")).join("\r\n")}\r\n`;
}
