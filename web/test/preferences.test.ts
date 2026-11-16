import assert from "node:assert/strict";
import test from "node:test";
import {
  browserLocale,
  readVisitorPreferences,
  saveVisitorPreferences,
} from "../src/app/preferences.ts";
import {
  calendarDate,
  civilDate,
  municipalToday,
  slotLabel,
} from "../src/features/catalog/dates.ts";
import { calendarLabel } from "../src/ui/lib/calendar-labels.ts";

test("locale follows supported browser languages and explicit visitor preference", () => {
  assert.equal(browserLocale(["en-US", "es-ES"]), "es");
  assert.equal(browserLocale(["gl-ES", "es"]), "gl");
  assert.equal(browserLocale(["en"]), "gl");
  assert.deepEqual(
    readVisitorPreferences(
      { getItem: () => '{"locale":"gl","theme":"dark"}' },
      ["es"],
    ),
    { locale: "gl", theme: "dark" },
  );
  assert.deepEqual(
    readVisitorPreferences({ getItem: () => '{"locale":"xx","theme":"bad"}' }, [
      "es",
    ]),
    { locale: "es", theme: null },
  );
  assert.equal(
    readVisitorPreferences(
      {
        getItem: () => {
          throw new Error("Disabled");
        },
      },
      ["es"],
    ).locale,
    "es",
  );
  assert.doesNotThrow(() =>
    saveVisitorPreferences(
      {
        setItem: () => {
          throw new Error("Disabled");
        },
      },
      { locale: "gl", theme: "dark" },
    ),
  );
});
test("municipal dates and repeated hours are independent of the browser timezone", () => {
  assert.equal(
    municipalToday("Europe/Madrid", new Date("2026-10-22T22:30:00Z")),
    "2026-10-23",
  );
  assert.equal(
    municipalToday("America/Los_Angeles", new Date("2026-10-22T01:00:00Z")),
    "2026-10-21",
  );
  assert.equal(civilDate(calendarDate("2026-10-25")), "2026-10-25");
  assert.equal(
    slotLabel("2026-10-25T00:30:00Z", "Europe/Madrid", "es"),
    "02:30",
  );
  assert.equal(
    slotLabel("2026-10-25T01:30:00Z", "Europe/Madrid", "es"),
    "02:30",
  );
});

test("calendar labels retain Galician month and weekday names without browser locale data", () => {
  const date = calendarDate("2026-10-22");
  assert.equal(calendarLabel(date, "gl", "month"), "outubro 2026");
  assert.equal(
    calendarLabel(date, "gl", "full"),
    "xoves, 22 de outubro de 2026",
  );
  assert.equal(calendarLabel(date, "es", "weekday"), "jue");
});
