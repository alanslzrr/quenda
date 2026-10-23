import assert from "node:assert/strict";
import test from "node:test";
import {
  allowed,
  canEnter,
  canExport,
  validPeriod,
} from "../src/features/reporting/model.ts";

test("reporting permissions preserve municipal scope and export permission intersection", () => {
  const m = {
    administrator: false,
    permissions: [
      { operation: "REPORT_READ", unitId: "a" },
      { operation: "DATA_EXPORT", unitId: "a" },
      { operation: "RESERVATION_READ", unitId: "b" },
    ],
  };
  assert.equal(allowed(m, "REPORT_READ", null), false);
  assert.equal(allowed(m, "REPORT_READ", "a"), true);
  assert.equal(canEnter(m), true);
  assert.equal(canEnter(m, true), false);
  assert.equal(canExport(m, "a"), false);
  m.permissions.push({ operation: "RESERVATION_MANAGE", unitId: "a" });
  assert.equal(canEnter(m, true), true);
  assert.equal(canExport(m, "a"), true);
  assert.equal(canExport(m, null), false);
  assert.equal(canExport({ administrator: true, permissions: [] }, null), true);
});
test("reporting periods validate calendar dates and the exclusive 366-day bound", () => {
  assert.equal(validPeriod("2024-01-01", "2025-01-01"), true);
  assert.equal(validPeriod("2024-01-01", "2025-01-02"), false);
  for (const pair of [
    ["2025-02-29", "2025-03-02"],
    ["2024-02-30", "2024-03-02"],
    ["2024-01-01", "2024-01-01"],
    ["", "2024-02-02"],
    ["2024-03-02", "2024-01-01"],
  ])
    assert.equal(validPeriod(pair[0], pair[1]), false);
});
