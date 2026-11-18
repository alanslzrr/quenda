// Every locale-sensitive format in the web app goes through this module, for two reasons.
//
// Building an Intl formatter costs far more than using one, and slot lists, calendars and charts
// ask for the same few configurations on every render, so each one is built once and reused.
// Locales are plain tags (not Intl.Locale objects) so the serialized key cannot collide.
//
// Some runtimes ship no Galician locale data (Chromium-based browsers among them). There a request
// for `gl` silently resolves to the browser's default locale or to the root locale: "2024 M03",
// "12,345.6", "yesterday". When that happens the formatters below use Spanish data, which has the
// same date order and separators, and rewrite what differs into Galician, matching CLDR `gl`.
type Locales = string | readonly string[] | undefined;

/** The subset of Intl.DateTimeFormat the app uses; the Galician fallback implements exactly this. */
export interface DateTimeFormatter {
  format(date?: Date | number): string;
  formatToParts(date?: Date | number): Intl.DateTimeFormatPart[];
  formatRange(start: Date | number, end: Date | number): string;
  formatRangeToParts(
    start: Date | number,
    end: Date | number,
  ): Intl.DateTimeRangeFormatPart[];
  resolvedOptions(): Intl.ResolvedDateTimeFormatOptions;
}

/** The subset of Intl.NumberFormat the app uses; the Galician fallback implements exactly this. */
export interface NumberFormatter {
  format(value: number | bigint): string;
  formatToParts(value: number | bigint): Intl.NumberFormatPart[];
  resolvedOptions(): Intl.ResolvedNumberFormatOptions;
}

/**
 * CLDR `gl` month and weekday names. Long and short names read the same alone and inside a date;
 * narrow ones inside a date are lowercase with a period ("7 de x."), see `narrowInDate`.
 */
export const galicianNames = {
  month: {
    long: ["xaneiro", "febreiro", "marzo", "abril", "maio", "xuño", "xullo", "agosto", "setembro", "outubro", "novembro", "decembro"],
    short: ["xan.", "feb.", "mar.", "abr.", "maio", "xuño", "xul.", "ago.", "set.", "out.", "nov.", "dec."],
    narrow: ["X", "F", "M", "A", "M", "X", "X", "A", "S", "O", "N", "D"],
  },
  // Sunday first, as Date#getDay counts.
  weekday: {
    long: ["domingo", "luns", "martes", "mércores", "xoves", "venres", "sábado"],
    short: ["dom.", "luns", "mar.", "mér.", "xov.", "ven.", "sáb."],
    narrow: ["D", "L", "M", "M", "X", "V", "S"],
  },
} as const;

const narrowInDate = (name: string) => `${name.toLowerCase()}.`;

const SPANISH = "es";

/** Whether a locale request asks for Galician first. */
function wantsGalician(locales: Locales) {
  const first = typeof locales === "string" ? locales : locales?.[0];
  return first?.trim().toLowerCase().split(/[-_]/)[0] === "gl";
}

/** A Galician request with Spanish in its place, so an explicit fallback list keeps working. */
function spanishInstead(locales: Locales) {
  return typeof locales === "string" || !locales ? SPANISH : [SPANISH, ...locales.slice(1)];
}

/** One probe answers for the whole runtime: browsers ship or strip a locale's data as a whole. */
export function runtimeHasGalician() {
  try {
    return (
      new Intl.DateTimeFormat("gl", { month: "long", timeZone: "UTC" }).format(
        Date.UTC(2024, 0, 15),
      ) === "xaneiro"
    );
  } catch {
    return false;
  }
}

/* ---------- Dates ---------- */

type NameField = "month" | "weekday";
type Width = "long" | "short" | "narrow";
const weekdayIndex: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/**
 * Spanish date data with Galician names. Spanish writes the abbreviated month without "de"
 * ("15 mar 2024"); Galician keeps it ("15 de mar. de 2024"), so that joint is rewritten too.
 */
export class GalicianDateTimeFormat implements DateTimeFormatter {
  readonly #spanish: Intl.DateTimeFormat;
  /** Reads the calendar month and weekday of an instant in the formatter's own time zone. */
  readonly #fields: Intl.DateTimeFormat;
  /** Spanish full names, to tell which width Spanish chose for a field. */
  readonly #spanishLong: Record<NameField, string[]>;

  constructor(locales: Locales, options?: Intl.DateTimeFormatOptions) {
    this.#spanish = new Intl.DateTimeFormat(spanishInstead(locales), options);
    const { timeZone } = this.#spanish.resolvedOptions();
    this.#fields = new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
      timeZone,
      month: "numeric",
      weekday: "short",
    });
    const name = (options: Intl.DateTimeFormatOptions, field: NameField, date: number) =>
      new Intl.DateTimeFormat(SPANISH, { ...options, timeZone: "UTC" })
        .formatToParts(date)
        .find((part) => part.type === field)?.value.toLowerCase() ?? "";
    this.#spanishLong = {
      month: Array.from({ length: 12 }, (_, index) =>
        name({ month: "long", day: "numeric" }, "month", Date.UTC(2024, index, 15)),
      ),
      weekday: Array.from({ length: 7 }, (_, index) =>
        name({ weekday: "long" }, "weekday", Date.UTC(2024, 0, 7 + index)),
      ),
    };
  }

  format(date?: Date | number) {
    return join(this.formatToParts(date));
  }

  formatToParts(date: Date | number = Date.now()) {
    return this.#galician(this.#spanish.formatToParts(date), () => date);
  }

  formatRange(start: Date | number, end: Date | number) {
    return join(this.formatRangeToParts(start, end));
  }

  formatRangeToParts(start: Date | number, end: Date | number) {
    return this.#galician(this.#spanish.formatRangeToParts(start, end), (part) =>
      part.source === "endRange" ? end : start,
    );
  }

  resolvedOptions() {
    return { ...this.#spanish.resolvedOptions(), locale: "gl" };
  }

  #galician<Part extends Intl.DateTimeFormatPart>(
    parts: Part[],
    dateOf: (part: Part) => Date | number,
  ): Part[] {
    const abbreviated = new Set<number>();
    // A range repeats the same field, so it is the variety of fields that makes a date.
    const inDate = new Set(parts.filter((part) => part.type !== "literal").map((part) => part.type)).size > 1;
    const named = parts.map((part, index) => {
      if (part.type !== "month" && part.type !== "weekday") return part;
      if (/^\d+$/.test(part.value)) return part;
      const field = part.type;
      const position = this.#position(field, dateOf(part));
      const width = this.#width(field, part.value, position);
      if (field === "month" && width !== "long") abbreviated.add(index);
      const name = galicianNames[field][width][position];
      if (name === undefined) return part;
      return { ...part, value: width === "narrow" && inDate ? narrowInDate(name) : name };
    });
    // Spanish joins an abbreviated month to its day and year with a bare space; Galician with "de".
    return named.map((part, index) => {
      const before = named[index - 1];
      const after = named[index + 1];
      const joint =
        part.type === "literal" &&
        /^\s$/u.test(part.value) &&
        ((before?.type === "day" && abbreviated.has(index + 1)) ||
          (abbreviated.has(index - 1) && after?.type === "year"));
      return joint ? { ...part, value: " de " } : part;
    });
  }

  /** The month (0–11) or weekday (0 = Sunday) of the instant, in the formatter's time zone. */
  #position(field: NameField, date: Date | number) {
    const value = this.#fields.formatToParts(date).find((part) => part.type === field)?.value ?? "";
    return field === "month" ? Number(value) - 1 : (weekdayIndex[value] ?? -1);
  }

  /** The width Spanish chose for the field, read back from the Spanish full name of the same value. */
  #width(field: NameField, spanish: string, index: number): Width {
    if (spanish.toLowerCase() === this.#spanishLong[field][index]) return "long";
    return [...spanish].length === 1 ? "narrow" : "short";
  }
}

/* ---------- Numbers ---------- */

/** Galician compact notation has no thousands form and no "mil M": 12.345, 1,2 M, 12.345,7 M, 1,5 B. */
const galicianCompact = [
  { from: 1e6, suffix: "M" },
  { from: 1e12, suffix: "B" },
] as const;

/**
 * Spanish number data with Galician grouping: Galician groups four-digit numbers ("1.234,5")
 * where Spanish does not ("1234,5"), and has its own compact forms.
 */
export class GalicianNumberFormat implements NumberFormatter {
  readonly #spanish: Intl.NumberFormat;
  /** Reads back the value a scaled compact number rounds to, so 999.999,96 becomes "1 M". */
  readonly #rounded?: Intl.NumberFormat;
  readonly #compact: boolean;

  constructor(locales: Locales, options: Intl.NumberFormatOptions = {}) {
    this.#compact = options.notation === "compact";
    const { notation, compactDisplay, ...rest } = options;
    const rounding = rest.minimumFractionDigits !== undefined ||
      rest.maximumFractionDigits !== undefined ||
      rest.minimumSignificantDigits !== undefined ||
      rest.maximumSignificantDigits !== undefined
      ? {}
      : // Compact notation's own default: whole numbers, or two significant digits when that says more.
        { maximumFractionDigits: 0, maximumSignificantDigits: 2, roundingPriority: "morePrecision" as const };
    // Galician groups from the first thousand ("auto" there means "always"); compact keeps "min2".
    const useGrouping =
      options.useGrouping === undefined || options.useGrouping === "auto"
        ? this.#compact
          ? ("min2" as const)
          : ("always" as const)
        : options.useGrouping;
    if (this.#compact && compactDisplay !== "long") {
      this.#spanish = new Intl.NumberFormat(spanishInstead(locales), { ...rest, ...rounding, useGrouping });
      this.#rounded = new Intl.NumberFormat("en-US", {
        ...rest,
        ...rounding,
        style: "decimal",
        useGrouping: false,
        signDisplay: "auto",
        numberingSystem: "latn",
      });
    } else {
      this.#compact = false;
      this.#spanish = new Intl.NumberFormat(spanishInstead(locales), { ...options, useGrouping });
    }
  }

  format(value: number | bigint) {
    return join(this.formatToParts(value));
  }

  formatToParts(exact: number | bigint): Intl.NumberFormatPart[] {
    if (!this.#compact || !this.#rounded) return this.#spanish.formatToParts(exact);
    const value = Number(exact);
    if (!Number.isFinite(value)) return this.#spanish.formatToParts(value);
    const rounded = this.#rounded;
    // The form follows the rounded value, so 999.999,96 carries into "1 M" while 999.999 stays whole.
    let form: (typeof galicianCompact)[number] | undefined;
    for (const next of galicianCompact) {
      const divisor = form?.from ?? 1;
      if (Math.abs(Number(rounded.format(value / divisor))) * divisor < next.from) break;
      form = next;
    }
    if (!form) return this.#spanish.formatToParts(value);
    return [
      ...this.#spanish.formatToParts(value / form.from),
      { type: "literal", value: "\u00a0" },
      { type: "compact", value: form.suffix },
    ];
  }

  resolvedOptions() {
    return {
      ...this.#spanish.resolvedOptions(),
      locale: "gl",
      ...(this.#compact ? { notation: "compact" as const, compactDisplay: "short" as const } : {}),
    };
  }
}

/* ---------- Factory ---------- */

const join = (parts: readonly { value: string }[]) => parts.map((part) => part.value).join("");

// The time zone travels inside the options, so it is part of the key too.
const keyOf = (locales: Locales, options: object | undefined) =>
  JSON.stringify([locales ?? null, options ?? null]);

function cached<Options extends object, T>(build: (locales: Locales, options?: Options) => T) {
  const entries = new Map<string, T>();
  return (locales: Locales, options?: Options) => {
    const key = keyOf(locales, options);
    let entry = entries.get(key);
    if (entry === undefined) {
      entry = build(locales, options);
      entries.set(key, entry);
    }
    return entry;
  };
}

/** Builds the formatter set for a runtime; `hasGalician` is asked once, on the first Galician request. */
export function createIntl(hasGalician: () => boolean = runtimeHasGalician) {
  let galician: boolean | undefined;
  const fallback = (locales: Locales) => {
    if (!wantsGalician(locales)) return false;
    galician ??= hasGalician();
    return !galician;
  };
  const dates = cached((locales, options?: Intl.DateTimeFormatOptions): DateTimeFormatter =>
    fallback(locales) ? new GalicianDateTimeFormat(locales, options) : new Intl.DateTimeFormat(locales, options),
  );
  const numbers = cached((locales, options?: Intl.NumberFormatOptions): NumberFormatter =>
    fallback(locales) ? new GalicianNumberFormat(locales, options) : new Intl.NumberFormat(locales, options),
  );
  // CLDR Galician collation is Spanish collation (ñ after n); the root order a runtime falls back to is not.
  const collators = cached((locales, options?: Intl.CollatorOptions) =>
    new Intl.Collator(fallback(locales) ? spanishInstead(locales) : locales, options),
  );
  return {
    dateTimeFormat: (locales: Locales, options?: Intl.DateTimeFormatOptions) => dates(locales, options),
    numberFormat: (locales: Locales, options?: Intl.NumberFormatOptions) => numbers(locales, options),
    collator: (locales: Locales, options?: Intl.CollatorOptions) => collators(locales, options),
  };
}

const intl = createIntl();

/** A cached date formatter; Galician output even where the runtime lacks Galician data. */
export const dateTimeFormat = intl.dateTimeFormat;
/** A cached number formatter; Galician output even where the runtime lacks Galician data. */
export const numberFormat = intl.numberFormat;
/** A cached collator; Galician order even where the runtime lacks Galician data. */
export const collator = intl.collator;

/** Locale-aware string order, through the cached collators. Without a locale, the runtime default. */
export const compareText = (a: string, b: string, locales?: Locales, options?: Intl.CollatorOptions) =>
  collator(locales, options).compare(a, b);

/** The browser's own time zone, for times told in the reader's zone. */
export const browserTimeZone = () => dateTimeFormat(undefined).resolvedOptions().timeZone;

/** Whether the runtime knows the IANA time zone; offsets such as "+01:00" are not zones here. */
export function isTimeZone(zone: string) {
  if (/^[+-]/.test(zone)) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
