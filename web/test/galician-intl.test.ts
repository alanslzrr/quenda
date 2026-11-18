import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import {
  createIntl,
  GalicianDateTimeFormat,
  GalicianNumberFormat,
  galicianNames,
  runtimeHasGalician,
} from "../src/ui/lib/intl-cache.ts";

// Node ships full ICU, so its own `gl` output is the reference the fallback must reproduce.
assert.equal(
  runtimeHasGalician(),
  true,
  "these tests need a Node build with Galician ICU data",
);

/** Every date option set the app formats with a caller's locale (Galician among them). */
const dateOptionSets: Intl.DateTimeFormatOptions[] = [
  { month: "long", year: "numeric" }, // month picker, reporting periods
  { month: "short" }, // month picker grid
  { dateStyle: "medium" }, // date picker field
  { dateStyle: "long" }, // legal notices, date range picker (spoken)
  { dateStyle: "full" }, // calendar "today" button
  { month: "short", day: "numeric", year: "numeric" }, // date range picker (compact)
  { weekday: "short" }, // calendar labels
  { weekday: "long" },
  { weekday: "long", day: "numeric", month: "long" },
  { weekday: "short", day: "numeric", month: "short" },
  {
    timeZone: "Europe/Madrid",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }, // slot times
  { timeZone: "Atlantic/Canary", hour: "2-digit", minute: "2-digit" }, // agenda arrival time
  { hour: "2-digit", minute: "2-digit" }, // analytics "data as of"
  // Not used by the app today, kept so a new caller does not meet a half-translated date.
  { month: "long" },
  { day: "numeric", month: "short" },
  { month: "short", year: "numeric" },
  { weekday: "long", day: "numeric", month: "long", year: "numeric" },
  { month: "narrow" },
  { weekday: "narrow" },
  { day: "numeric", month: "narrow" },
  { weekday: "narrow", day: "numeric" },
];
/** Date-only sets also go through formatRange in the app. */
const rangeOptionSets = dateOptionSets.filter(
  (options) => !("hour" in options),
);

/** Every number option set the app formats with a caller's locale. */
const numberOptionSets: Intl.NumberFormatOptions[] = [
  {}, // sparkline
  { maximumFractionDigits: 0 }, // bar chart
  { maximumFractionDigits: 1 }, // line chart
  { notation: "compact", maximumFractionDigits: 1 }, // line chart ticks
  { maximumFractionDigits: 0, numberingSystem: "latn" }, // split bar values
  {
    style: "percent",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
    numberingSystem: "latn",
  }, // split bar shares
  { maximumFractionDigits: 1, minimumFractionDigits: 0 }, // analytics figures
  { maximumFractionDigits: 0, minimumFractionDigits: 0 },
  {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    numberingSystem: "latn",
  }, // animated counter
  {
    minimumFractionDigits: 0,
    maximumFractionDigits: 3,
    useGrouping: true,
    numberingSystem: "latn",
  }, // number field
  {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
    useGrouping: false,
    numberingSystem: "latn",
  },
  { numberingSystem: "latn" }, // number field separators
  { style: "percent" },
];

// Every month and weekday, both ends of the day, so time-zone shifts move the calendar date too.
const instants = Array.from({ length: 12 }, (_, month) =>
  [1, 9, 15, 28].flatMap((day) => [
    new Date(Date.UTC(2024, month, day, 0, 5)),
    new Date(Date.UTC(2025, month, day, 23, 40)),
  ]),
).flat();
const numbers = [
  0,
  -0,
  0.004,
  0.04,
  0.5,
  0.82,
  0.8235,
  1,
  5.67,
  12,
  99.95,
  999,
  1000,
  1234,
  1234.5,
  9999,
  10000,
  12345.6,
  99999,
  123456,
  999999,
  999999.4,
  999999.96,
  1e6,
  1050000,
  1250000,
  12.5e6,
  5.5e8,
  1e9,
  1e11,
  999999e6,
  1e12,
  1.5e12,
  1e15,
  -1,
  -1234.5,
  -2.5e6,
  Number.NaN,
  Number.POSITIVE_INFINITY,
];
const galicianTags = ["gl", "gl-ES", ["gl-ES", "es-ES"]] as const;

test("the Galician names are CLDR gl names in every width", () => {
  for (const width of ["long", "short", "narrow"] as const) {
    const month = new Intl.DateTimeFormat("gl", {
      month: width,
      timeZone: "UTC",
    });
    const inDate = new Intl.DateTimeFormat("gl", {
      month: width,
      day: "numeric",
      timeZone: "UTC",
    });
    const inDateName = (name: string) =>
      width === "narrow" ? `${name.toLowerCase()}.` : name;
    const weekday = new Intl.DateTimeFormat("gl", {
      weekday: width,
      timeZone: "UTC",
    });
    const name = (format: Intl.DateTimeFormat, type: string, date: number) =>
      format.formatToParts(date).find((part) => part.type === type)?.value;
    assert.deepEqual(
      galicianNames.month[width],
      Array.from({ length: 12 }, (_, index) =>
        name(month, "month", Date.UTC(2024, index, 15)),
      ),
    );
    assert.deepEqual(
      [...galicianNames.month[width]].map(inDateName),
      Array.from({ length: 12 }, (_, index) =>
        name(inDate, "month", Date.UTC(2024, index, 15)),
      ),
    );
    assert.deepEqual(
      galicianNames.weekday[width],
      Array.from({ length: 7 }, (_, index) =>
        name(weekday, "weekday", Date.UTC(2024, 0, 7 + index)),
      ),
    );
  }
});

test("the date fallback reproduces CLDR gl for every option set the app uses", () => {
  for (const locales of galicianTags) {
    for (const options of dateOptionSets) {
      const expected = new Intl.DateTimeFormat("gl", options);
      const actual = new GalicianDateTimeFormat(locales, options);
      for (const instant of instants) {
        assert.deepEqual(
          actual.formatToParts(instant),
          expected.formatToParts(instant),
          `${JSON.stringify(options)} ${instant.toISOString()}`,
        );
        assert.equal(actual.format(instant), expected.format(instant));
      }
      assert.equal(actual.resolvedOptions().locale, "gl");
      assert.equal(
        actual.resolvedOptions().timeZone,
        expected.resolvedOptions().timeZone,
      );
    }
  }
});

test("the date fallback reproduces CLDR gl ranges within a month, across months and across years", () => {
  for (const options of rangeOptionSets) {
    const expected = new Intl.DateTimeFormat("gl", options);
    const actual = new GalicianDateTimeFormat("gl", options);
    for (const start of instants) {
      for (const days of [0, 3, 40, 400]) {
        const end = new Date(start.getTime() + days * 86_400_000);
        assert.deepEqual(
          actual.formatRangeToParts(start, end),
          expected.formatRangeToParts(start, end),
          `${JSON.stringify(options)} ${start.toISOString()} +${days}`,
        );
        assert.equal(
          actual.formatRange(start, end),
          expected.formatRange(start, end),
        );
      }
    }
  }
});

test("the number fallback reproduces CLDR gl for every option set the app uses", () => {
  for (const locales of galicianTags) {
    for (const options of numberOptionSets) {
      const expected = new Intl.NumberFormat("gl", options);
      const actual = new GalicianNumberFormat(locales, options);
      for (const value of numbers) {
        assert.deepEqual(
          actual.formatToParts(value),
          expected.formatToParts(value),
          `${JSON.stringify(options)} ${value}`,
        );
        assert.equal(actual.format(value), expected.format(value));
      }
      assert.equal(
        actual.format(12_345_678_901_234n),
        expected.format(12_345_678_901_234n),
      );
    }
  }
});

test("a runtime without Galician data formats Galician requests in Galician", () => {
  let probes = 0;
  const intl = createIntl(() => {
    probes += 1;
    return false;
  });
  const march = new Date(Date.UTC(2024, 2, 15, 12));
  assert.equal(
    intl.dateTimeFormat("gl", { month: "long", year: "numeric" }).format(march),
    "marzo de 2024",
  );
  assert.equal(
    intl
      .dateTimeFormat("gl-ES", {
        weekday: "short",
        day: "numeric",
        month: "short",
        timeZone: "UTC",
      })
      .format(march),
    "ven., 15 de mar.",
  );
  assert.equal(
    intl
      .dateTimeFormat("gl", { dateStyle: "medium", timeZone: "UTC" })
      .format(march),
    "15 de mar. de 2024",
  );
  assert.equal(
    intl
      .dateTimeFormat("gl", { dateStyle: "full", timeZone: "UTC" })
      .format(new Date(Date.UTC(2024, 0, 4))),
    "xoves, 4 de xaneiro de 2024",
  );
  assert.equal(
    intl.numberFormat(["gl-ES", "es-ES"]).format(12345.6),
    "12.345,6",
  );
  assert.equal(intl.numberFormat("gl").format(1234.5), "1.234,5");
  assert.equal(
    intl.numberFormat("gl", { style: "percent" }).format(0.82),
    "82 %",
  );
  assert.equal(
    intl
      .numberFormat("gl", { notation: "compact", maximumFractionDigits: 1 })
      .format(12345),
    "12.345",
  );
  assert.deepEqual(["nz", "ña", "oa"].sort(intl.collator("gl").compare), [
    "nz",
    "ña",
    "oa",
  ]);
  assert.ok(
    intl.dateTimeFormat("gl", { month: "long" }) instanceof
      GalicianDateTimeFormat,
  );
  assert.ok(intl.numberFormat("gl") instanceof GalicianNumberFormat);
  // Spanish and other locales keep the runtime's own formatters and never ask about Galician.
  assert.ok(
    intl.dateTimeFormat("es", { month: "long" }) instanceof Intl.DateTimeFormat,
  );
  assert.ok(intl.numberFormat("es-ES") instanceof Intl.NumberFormat);
  assert.equal(intl.numberFormat("es").format(1234.5), "1234,5");
  assert.equal(probes, 1, "the runtime is probed once");
});

test("a runtime with Galician data uses it directly", () => {
  const intl = createIntl(() => true);
  const format = intl.dateTimeFormat("gl", { month: "long" });
  assert.ok(format instanceof Intl.DateTimeFormat);
  assert.equal(format.format(new Date(2024, 0, 15)), "xaneiro");
  assert.ok(intl.numberFormat("gl") instanceof Intl.NumberFormat);
});

test("the cached formatters are reused per locale and options", () => {
  const intl = createIntl(() => false);
  assert.equal(
    intl.dateTimeFormat("gl", { month: "short" }),
    intl.dateTimeFormat("gl", { month: "short" }),
  );
  assert.equal(intl.numberFormat("gl"), intl.numberFormat("gl"));
  assert.equal(
    intl.collator("gl", { numeric: true }),
    intl.collator("gl", { numeric: true }),
  );
});

/** Formatting outside the central module would bypass the Galician fallback and the formatter cache. */
const forbidden = [
  /\bIntl\.(DateTimeFormat|NumberFormat|RelativeTimeFormat|ListFormat|PluralRules|DisplayNames|Collator|DurationFormat)\s*\(/,
  /\.toLocale(Date|Time)?String\s*\(/,
  /\.localeCompare\s*\(/,
];

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

test("web sources format locale-sensitive text only through the central Intl module", () => {
  const root = new URL("../src", import.meta.url).pathname;
  const central = join(root, "ui/lib/intl-cache.ts");
  const offences = sources(root)
    .filter((path) => path !== central)
    .flatMap((path) =>
      readFileSync(path, "utf8")
        .split("\n")
        .flatMap((line, index) =>
          forbidden.some((pattern) => pattern.test(line))
            ? [`${relative(root, path)}:${index + 1}: ${line.trim()}`]
            : [],
        ),
    );
  assert.deepEqual(offences, []);
});
