import assert from "node:assert/strict";
import test from "node:test";
import {
  browserLocale,
  readVisitorPreferences,
  saveVisitorPreferences,
} from "../src/app/preferences.ts";
import { paletteColors } from "../src/app/theme.ts";
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
function luminance(hex: string) {
  const bytes = hex.slice(1).match(/../g);
  assert.ok(bytes);
  const [r, g, b] = bytes.map((value) => {
    const n = Number.parseInt(value, 16) / 255;
    return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
  });
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}
function contrast(a: string, b: string) {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
}
test("all fixed palettes satisfy text, action and focus contrast in both modes", () => {
  for (const [mode, palettes] of Object.entries(paletteColors))
    for (const [name, palette] of Object.entries(palettes)) {
      for (const background of [palette.background, palette.surface]) {
        assert.ok(
          contrast(palette.text, background) >= 4.5,
          `${mode}/${name} text`,
        );
        assert.ok(
          contrast(palette.secondary, background) >= 4.5,
          `${mode}/${name} secondary`,
        );
        assert.ok(
          contrast(palette.accent, background) >= 3,
          `${mode}/${name} focus`,
        );
        assert.ok(
          contrast(palette.border, background) >= 3,
          `${mode}/${name} control border`,
        );
      }
      assert.ok(
        contrast(palette.onAccent, palette.accent) >= 4.5,
        `${mode}/${name} button text`,
      );
    }
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
