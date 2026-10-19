import assert from "node:assert/strict";
import test from "node:test";
import { weeklyQuotaPeriod } from "../../src/modules/collaboration/index.ts";

test("weekly quota uses local Monday and a half-open civil week", () => {
  const previous = weeklyQuotaPeriod("2026-07-05T21:59:59Z", "Europe/Madrid");
  const next = weeklyQuotaPeriod("2026-07-05T22:00:00Z", "Europe/Madrid");
  assert.equal(previous.weekStart, "2026-06-29");
  assert.equal(next.weekStart, "2026-07-06");
  assert.equal(previous.endsAt, next.startsAt);
  assert.deepEqual(next, {
    weekStart: "2026-07-06",
    startsAt: "2026-07-05T22:00:00.000Z",
    endsAt: "2026-07-12T22:00:00.000Z",
  });
});
test("DST quota weeks are not fixed 168-hour intervals", () => {
  const spring = weeklyQuotaPeriod("2026-03-25T12:00Z", "Europe/Madrid");
  const autumn = weeklyQuotaPeriod("2026-10-21T12:00Z", "Europe/Madrid");
  assert.equal(
    (Date.parse(spring.endsAt) - Date.parse(spring.startsAt)) / 3600000,
    167,
  );
  assert.equal(
    (Date.parse(autumn.endsAt) - Date.parse(autumn.startsAt)) / 3600000,
    169,
  );
  assert.equal(
    weeklyQuotaPeriod("2026-01-01T12:00Z", "Europe/Madrid").weekStart,
    "2025-12-29",
  );
});
test("quota attribution distinguishes agreement zones and rejects invalid instants and offset-only zones", () => {
  const instant = "2026-07-05T22:30:00Z";
  assert.equal(weeklyQuotaPeriod(instant, "UTC").weekStart, "2026-06-29");
  assert.equal(
    weeklyQuotaPeriod(instant, "Europe/Madrid").weekStart,
    "2026-07-06",
  );
  for (const zone of ["+01:00", "-03:00", "Missing/Zone", ""])
    assert.throws(() => weeklyQuotaPeriod(instant, zone), {
      code: "INVALID_INPUT",
    });
  assert.throws(() => weeklyQuotaPeriod("2026-07-05T22:30", "UTC"), {
    code: "INVALID_INPUT",
  });
});
