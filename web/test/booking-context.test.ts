import assert from "node:assert/strict";
import test from "node:test";
import { resolveBookingDate } from "../src/features/catalog/dates.ts";

test("booking dates preserve real current/future civil days", () => {
  for (const requested of ["2026-10-24", "2026-12-31", "2028-02-29"]) {
    assert.deepEqual(resolveBookingDate(requested, "2026-10-24"), {
      date: requested,
      dateAdjusted: false,
    });
  }
});

test("nonexistent, malformed and past dates fall back explicitly to today", () => {
  for (const requested of [
    "2026-10-23",
    "2026-10-32",
    "2026-11-31",
    "2027-02-29",
    "2026-13-01",
    "2026-00-01",
    "2026-10-00",
    "2026-1-1",
    "2026-10-26T00:00:00Z",
    "invalid",
  ]) {
    assert.deepEqual(resolveBookingDate(requested, "2026-10-24"), {
      date: "2026-10-24",
      dateAdjusted: true,
    });
  }
  assert.deepEqual(resolveBookingDate("", "2026-10-24"), {
    date: "2026-10-24",
    dateAdjusted: false,
  });
});
