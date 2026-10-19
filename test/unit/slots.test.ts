import assert from "node:assert/strict";
import test from "node:test";
import type { UnitCalendarInput } from "../../src/modules/catalog/calendar.ts";
import { calendarSlots } from "../../src/modules/catalog/slots.ts";

const rules = (startMinute = 480, endMinute = 720): UnitCalendarInput => ({
  minimumMinutes: 30,
  maximumMinutes: 120,
  stepMinutes: 30,
  advanceDays: null,
  weekly: Array.from({ length: 7 }, (_, i) => ({
    day: i + 1,
    startMinute,
    endMinute,
  })),
  exceptions: [],
});
const query = (
  calendar = rules(),
  date = "2026-10-19",
  durationMinutes = 60,
  now = "2026-10-18T10:00:00Z",
) => ({
  calendar,
  date,
  durationMinutes,
  now,
  timeZone: "Europe/Madrid",
  municipalAdvanceDays: 30,
});

test("slots honor duration, grid, inclusive closing boundary and strict future starts", () => {
  const slots = calendarSlots(query());
  assert.equal(slots.length, 7);
  assert.equal(slots[0]?.start.local, "2026-10-19T08:00");
  assert.equal(slots.at(-1)?.end.local, "2026-10-19T12:00");
  assert.equal(
    calendarSlots(query(rules(), "2026-10-19", 60, "2026-10-19T06:00:00Z"))[0]
      ?.start.local,
    "2026-10-19T08:30",
  );
  assert.throws(() => calendarSlots(query(rules(), "2026-10-19", 45)), {
    code: "INVALID_INPUT",
  });
  assert.throws(() => calendarSlots(query(rules(), "2026-10-19", 150)), {
    code: "INVALID_INPUT",
  });
});

test("a slot cannot cross a closure, including the gap between repeated-hour openings", () => {
  const calendar = rules();
  calendar.exceptions = [
    {
      date: "2026-10-19",
      intervals: [
        { startMinute: 480, endMinute: 540 },
        { startMinute: 570, endMinute: 660 },
      ],
    },
  ];
  assert.deepEqual(
    calendarSlots(query(calendar)).map((row) => row.start.local),
    ["2026-10-19T08:00", "2026-10-19T09:30", "2026-10-19T10:00"],
  );
  const repeated = rules(150, 165);
  repeated.minimumMinutes = 15;
  repeated.stepMinutes = 15;
  const options = calendarSlots(
    query(repeated, "2026-10-25", 15, "2026-10-24T10:00:00Z"),
  );
  assert.equal(options.length, 2);
  assert.deepEqual(
    options.map((row) => row.start.offset),
    ["+02:00", "+01:00"],
  );
  assert.deepEqual(
    calendarSlots(query(repeated, "2026-10-25", 30, "2026-10-24T10:00:00Z")),
    [],
  );
});

test("elapsed duration survives DST and nonexistent starts are never generated", () => {
  const slots = calendarSlots(
    query(rules(90, 240), "2026-03-29", 60, "2026-03-28T10:00:00Z"),
  );
  assert.deepEqual(
    slots.map((row) => row.start.local),
    ["2026-03-29T01:30", "2026-03-29T03:00"],
  );
  assert.equal(slots[0]?.end.local, "2026-03-29T03:30");
  for (const slot of slots)
    assert.equal(
      Date.parse(slot.end.utc) - Date.parse(slot.start.utc),
      3600000,
    );
});

test("midnight crossings need continuous opening on the next day and respect exceptions", () => {
  const calendar = rules(1380, 1440);
  calendar.weekly.push({ day: 2, startMinute: 0, endMinute: 60 });
  let slots = calendarSlots(query(calendar));
  assert.deepEqual(
    slots.map((row) => row.start.local),
    ["2026-10-19T23:00", "2026-10-19T23:30"],
  );
  assert.equal(slots[1]?.end.local, "2026-10-20T00:30");
  calendar.exceptions = [{ date: "2026-10-20", intervals: [] }];
  slots = calendarSlots(query(calendar));
  assert.deepEqual(
    slots.map((row) => row.start.local),
    ["2026-10-19T23:00"],
  );
});

test("full weekly opening still observes dated closures and unit advance reductions", () => {
  const calendar = rules(0, 1440);
  calendar.advanceDays = 0;
  assert.deepEqual(calendarSlots(query(calendar)), []);
  calendar.advanceDays = null;
  calendar.exceptions = [{ date: "2026-10-20", intervals: [] }];
  const slots = calendarSlots(query(calendar, "2026-10-19", 120));
  assert.equal(slots.at(-1)?.start.local, "2026-10-19T22:00");
  calendar.exceptions = [{ date: "2026-10-19", intervals: [] }];
  assert.deepEqual(calendarSlots(query(calendar)), []);
});
