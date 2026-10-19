import assert from "node:assert/strict";
import test from "node:test";
import type { UnitCalendarInput } from "../../src/modules/catalog/calendar.ts";
import { utcOpeningIntervals } from "../../src/modules/catalog/opening.ts";

const calendar = (
  startMinute: number,
  endMinute: number,
): UnitCalendarInput => ({
  minimumMinutes: 15,
  maximumMinutes: 120,
  stepMinutes: 15,
  advanceDays: null,
  weekly: Array.from({ length: 7 }, (_, i) => ({
    day: i + 1,
    startMinute,
    endMinute,
  })),
  exceptions: [],
});

test("partial repeated-hour openings stay separate rather than exposing a closed interval", () => {
  assert.deepEqual(
    utcOpeningIntervals(calendar(150, 165), "2026-10-25", "Europe/Madrid"),
    [
      { start: "2026-10-25T00:30:00.000Z", end: "2026-10-25T00:45:00.000Z" },
      { start: "2026-10-25T01:30:00.000Z", end: "2026-10-25T01:45:00.000Z" },
    ],
  );
  assert.deepEqual(
    utcOpeningIntervals(calendar(90, 105), "2026-04-05", "Australia/Lord_Howe"),
    [
      { start: "2026-04-04T14:30:00.000Z", end: "2026-04-04T14:45:00.000Z" },
      { start: "2026-04-04T15:00:00.000Z", end: "2026-04-04T15:15:00.000Z" },
    ],
  );
});

test("nonexistent openings disappear and intervals crossing a transition preserve real duration", () => {
  assert.deepEqual(
    utcOpeningIntervals(calendar(120, 180), "2026-03-29", "Europe/Madrid"),
    [],
  );
  assert.deepEqual(
    utcOpeningIntervals(calendar(90, 210), "2026-03-29", "Europe/Madrid"),
    [{ start: "2026-03-29T00:30:00.000Z", end: "2026-03-29T01:30:00.000Z" }],
  );
  assert.deepEqual(
    utcOpeningIntervals(calendar(90, 210), "2026-10-25", "Europe/Madrid"),
    [{ start: "2026-10-24T23:30:00.000Z", end: "2026-10-25T02:30:00.000Z" }],
  );
});

test("whole-day openings follow 23/25-hour days and an entirely skipped date", () => {
  const full = calendar(0, 1440);
  for (const [date, hours] of [
    ["2026-03-29", 23],
    ["2026-10-25", 25],
    ["2026-10-26", 24],
  ] as const) {
    const intervals = utcOpeningIntervals(full, date, "Europe/Madrid");
    assert.equal(intervals.length, 1);
    const item = intervals[0];
    assert.ok(item);
    assert.equal(
      (Date.parse(item.end) - Date.parse(item.start)) / 3600000,
      hours,
    );
  }
  assert.deepEqual(utcOpeningIntervals(full, "2011-12-30", "Pacific/Apia"), []);
});

test("dated closures and split openings apply before conversion without inventing availability", () => {
  const rules = calendar(480, 720);
  rules.exceptions = [{ date: "2026-10-19", intervals: [] }];
  assert.deepEqual(
    utcOpeningIntervals(rules, "2026-10-19", "Europe/Madrid"),
    [],
  );
  rules.exceptions = [
    {
      date: "2026-10-19",
      intervals: [
        { startMinute: 480, endMinute: 540 },
        { startMinute: 600, endMinute: 660 },
      ],
    },
  ];
  assert.deepEqual(utcOpeningIntervals(rules, "2026-10-19", "Europe/Madrid"), [
    { start: "2026-10-19T06:00:00.000Z", end: "2026-10-19T07:00:00.000Z" },
    { start: "2026-10-19T08:00:00.000Z", end: "2026-10-19T09:00:00.000Z" },
  ]);
});
