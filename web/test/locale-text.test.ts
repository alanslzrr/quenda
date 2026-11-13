import assert from "node:assert/strict";
import test from "node:test";
import {
  noDataText,
  numberLocales,
  pickText,
  uiLanguage,
} from "../src/ui/lib/locale-text.ts";

test("component copy follows the product languages and falls back to English", () => {
  assert.equal(uiLanguage("gl"), "gl");
  assert.equal(uiLanguage("gl-ES"), "gl");
  assert.equal(uiLanguage("es"), "es");
  assert.equal(uiLanguage("ES-es"), "es");
  assert.equal(uiLanguage("fr"), "en");
  assert.equal(
    pickText("gl", {
      gl: "Mes seguinte",
      es: "Mes siguiente",
      en: "Next month",
    }),
    "Mes seguinte",
  );
  assert.equal(noDataText("gl"), "sen datos");
  assert.equal(noDataText("es"), "sin datos");
});

test("number formatting asks for the given locale first and Spanish after it", () => {
  assert.deepEqual(numberLocales("gl"), ["gl", "es-ES"]);
  assert.deepEqual(numberLocales("es-ES"), ["es-ES"]);
  assert.deepEqual(numberLocales(""), ["es-ES"]);
  const format = new Intl.NumberFormat(numberLocales("gl"), {
    maximumFractionDigits: 1,
  });
  // Galician and Spanish both write a decimal comma.
  assert.match(format.format(12.5), /^12,5$/);
});
