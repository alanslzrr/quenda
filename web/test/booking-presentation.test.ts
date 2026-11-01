import assert from "node:assert/strict";
import test from "node:test";
import {
  durationLabel,
  durationOptions,
  endsNextDay,
  intervalLabel,
  localTimeLabel,
} from "../src/features/catalog/dates.ts";

test("duration choices reflect the unit configuration, not a fixed thirty minute booking", () => {
  assert.deepEqual(
    durationOptions({
      minimumMinutes: 30,
      maximumMinutes: 120,
      stepMinutes: 30,
    }),
    [30, 60, 90, 120],
  );
  assert.deepEqual(
    durationOptions({
      minimumMinutes: 60,
      maximumMinutes: 120,
      stepMinutes: 60,
    }),
    [60, 120],
  );
  assert.equal(durationLabel(90), "1 h 30 min");
});
test("ordinary municipal times hide UTC but repeated autumn times remain distinguishable", () => {
  assert.equal(
    localTimeLabel("2026-10-23T17:30:00Z", "Europe/Madrid", "es"),
    "19:30",
  );
  assert.match(
    localTimeLabel("2026-10-25T00:30:00Z", "Europe/Madrid", "es"),
    /UTC\+02:00/,
  );
  assert.match(
    localTimeLabel("2026-10-25T01:30:00Z", "Europe/Madrid", "es"),
    /UTC\+01:00/,
  );
});
test("large valid duration ranges do not allocate an unbounded option list", () => {
  assert.equal(
    durationOptions({
      minimumMinutes: 1,
      maximumMinutes: 2147483647,
      stepMinutes: 1,
    }).length,
    48,
  );
});

test("intervals name the municipal day and mark bookings that end after midnight", () => {
  const start = "2026-10-24T21:30:00.000Z";
  const end = "2026-10-24T22:30:00.000Z";
  assert.equal(
    intervalLabel(start, end, "Europe/Madrid", "es"),
    "sábado, 24 de octubre · 23:30–00:30",
  );
  assert.equal(endsNextDay(start, end, "Europe/Madrid"), true);
  assert.equal(
    endsNextDay(start, "2026-10-24T21:59:00.000Z", "Europe/Madrid"),
    false,
  );
});
