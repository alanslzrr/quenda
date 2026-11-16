import assert from "node:assert/strict";
import test from "node:test";
import { slotLabel } from "../src/features/catalog/dates.ts";
import { dateTimeFormat, numberFormat } from "../src/ui/lib/intl-cache.ts";

test("formatters are reused for the same locale, time zone and options", () => {
  const options = { timeZone: "Europe/Madrid", hour: "2-digit" } as const;
  assert.equal(
    dateTimeFormat("es", options),
    dateTimeFormat("es", { ...options }),
  );
  assert.notEqual(
    dateTimeFormat("es", options),
    dateTimeFormat("es", { ...options, timeZone: "Atlantic/Canary" }),
  );
  assert.notEqual(dateTimeFormat("es", options), dateTimeFormat("gl", options));
  assert.equal(
    numberFormat(["gl-ES", "es-ES"], { maximumFractionDigits: 1 }),
    numberFormat(["gl-ES", "es-ES"], { maximumFractionDigits: 1 }),
  );
  assert.notEqual(numberFormat("es"), numberFormat("es", { style: "percent" }));
});

test("cached formatters keep each municipality's time zone", () => {
  const instant = "2026-07-01T10:00:00Z";
  assert.equal(slotLabel(instant, "Europe/Madrid", "es"), "12:00");
  assert.equal(slotLabel(instant, "Atlantic/Canary", "es"), "11:00");
  assert.equal(slotLabel(instant, "Europe/Madrid", "es"), "12:00");
});
