import assert from "node:assert/strict";
import test from "node:test";
import { civilDate, civilMonth } from "../../src/shared/civil-date.ts";

test("civil inputs reject year zero and impossible dates before SQL", () => {
  for (const value of ["0000-01-01", "2026-02-30", "2026-13-01", "10000-01-01"])
    assert.throws(() => civilDate(value), { code: "INVALID_INPUT" });
  for (const value of ["0000-01", "2026-13", "2026-1"])
    assert.throws(() => civilMonth(value), { code: "INVALID_INPUT" });
  for (const value of ["0001-01-01", "9999-12-31", "2024-02-29"])
    assert.equal(civilDate(value), value);
});
