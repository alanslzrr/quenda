import assert from "node:assert/strict";
import test from "node:test";
import { nextWeekdayOffset, valdeira } from "../demo/seed.ts";

test("cancelled demo reservation selects an open hall weekday for every launch day", () => {
  const hall = valdeira.facilities
    .flatMap((facility) => facility.units)
    .find((unit) => unit.id.endsWith("d122"));
  assert.ok(hall);
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Madrid",
    weekday: "short",
  });
  // This week crosses the autumn clock change as well as all seven launch days.
  for (let day = 19; day <= 25; day++) {
    const from = new Date(`2026-10-${day}T12:00:00Z`);
    const offset = nextWeekdayOffset(1, 7, from);
    assert.ok(offset >= 7 && offset < 14);
    assert.equal(
      weekday.format(new Date(from.getTime() + offset * 86400000)),
      "Mon",
    );
    assert.ok(
      hall.weekly.some(
        (opening) =>
          opening.days.includes(1) &&
          opening.startMinute <= 11 * 60 &&
          opening.endMinute >= 12 * 60 + 30,
      ),
    );
    const saturday = nextWeekdayOffset(6, 2, from);
    assert.ok(saturday >= 2 && saturday < 9);
    assert.equal(
      weekday.format(new Date(from.getTime() + saturday * 86400000)),
      "Sat",
    );
  }
});
