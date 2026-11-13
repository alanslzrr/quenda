import assert from "node:assert/strict";
import test from "node:test";
import {
  dateRangeText,
  formatRangeShort,
  formatRangeSpoken,
} from "../src/ui/date-range-picker/labels.ts";

const day = (year: number, month: number, date: number) =>
  new Date(year, month - 1, date);

test("short date ranges use Galician and Spanish month names", () => {
  assert.equal(
    formatRangeShort({ start: day(2026, 3, 3), end: day(2026, 3, 3) }, "gl"),
    "3 mar 2026",
  );
  assert.equal(
    formatRangeShort({ start: day(2026, 3, 3), end: day(2026, 3, 9) }, "es"),
    "3–9 mar 2026",
  );
  assert.equal(
    formatRangeShort({ start: day(2026, 1, 28), end: day(2026, 2, 3) }, "gl"),
    "28 xan – 3 feb 2026",
  );
  assert.equal(
    formatRangeShort({ start: day(2025, 12, 28), end: day(2026, 1, 3) }, "es"),
    "28 dic 2025 – 3 ene 2026",
  );
});

test("spoken date ranges name the whole months and read as words", () => {
  assert.equal(
    formatRangeSpoken({ start: day(2026, 3, 3), end: day(2026, 3, 9) }, "gl"),
    "do 3 ao 9 de marzo de 2026",
  );
  assert.equal(
    formatRangeSpoken({ start: day(2026, 3, 3), end: day(2026, 3, 9) }, "es"),
    "del 3 al 9 de marzo de 2026",
  );
  assert.equal(
    formatRangeSpoken({ start: day(2026, 6, 28), end: day(2026, 7, 3) }, "gl"),
    "do 28 de xuño ao 3 de xullo de 2026",
  );
  assert.equal(
    formatRangeSpoken({ start: day(2025, 12, 28), end: day(2026, 1, 3) }, "es"),
    "del 28 de diciembre de 2025 al 3 de enero de 2026",
  );
  assert.equal(
    formatRangeSpoken({ start: day(2026, 3, 3), end: day(2026, 3, 3) }, "es"),
    "3 de marzo de 2026",
  );
});

test("the date range picker writes every control name in both languages", () => {
  const gl = dateRangeText("gl");
  const es = dateRangeText("es");
  assert.deepEqual(
    [
      gl.previousMonth,
      gl.nextMonth,
      gl.apply,
      gl.cancel,
      gl.placeholder,
      gl.label,
    ],
    [
      "Mes anterior",
      "Mes seguinte",
      "Aplicar",
      "Cancelar",
      "Escolle as datas",
      "Intervalo de datas",
    ],
  );
  assert.deepEqual(
    [
      es.previousMonth,
      es.nextMonth,
      es.apply,
      es.cancel,
      es.placeholder,
      es.label,
    ],
    [
      "Mes anterior",
      "Mes siguiente",
      "Aplicar",
      "Cancelar",
      "Elige las fechas",
      "Intervalo de fechas",
    ],
  );
  assert.equal(gl.days(1), "1 día");
  assert.equal(es.days(7), "7 días");
  // 2 March 2026 is a Monday.
  assert.equal(gl.weekdayShort(day(2026, 3, 2)), "lu");
  assert.equal(es.weekdayLong(day(2026, 3, 4)), "miércoles");
  assert.equal(gl.day(day(2026, 3, 2)), "luns, 2 de marzo de 2026");
  assert.equal(es.monthTitle(day(2026, 3, 1)), "marzo 2026");
});
