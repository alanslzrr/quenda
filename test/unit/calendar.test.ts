import assert from "node:assert/strict";
import test from "node:test";
import {
  localDate,
  localOpeningIntervals,
  type UnitCalendarInput,
  validateUnitCalendar,
} from "../../src/modules/catalog/calendar.ts";

const valid = (): UnitCalendarInput => ({
  minimumMinutes: 30,
  maximumMinutes: 120,
  stepMinutes: 30,
  advanceDays: null,
  weekly: [
    { day: 1, startMinute: 600, endMinute: 720 },
    { day: 1, startMinute: 480, endMinute: 600 },
    { day: 7, startMinute: 0, endMinute: 1440 },
  ],
  exceptions: [],
});

test("calendar validation normalizes without mutating input and keeps civil time separate", () => {
  const original = valid();
  const snapshot = structuredClone(original);
  const calendar = validateUnitCalendar(original, 30);
  assert.deepEqual(original, snapshot);
  assert.equal(calendar.weekly[0]?.startMinute, 480);
  assert.deepEqual(localOpeningIntervals(calendar, "2026-10-19"), [
    { startMinute: 480, endMinute: 720 },
  ]);
  assert.deepEqual(localOpeningIntervals(calendar, "2026-10-18"), [
    { startMinute: 0, endMinute: 1440 },
  ]);
  assert.deepEqual(localOpeningIntervals(calendar, "2026-10-20"), []);
  assert.equal(
    validateUnitCalendar({ ...valid(), advanceDays: 0 }, 0).advanceDays,
    0,
  );
  assert.equal(
    validateUnitCalendar({ ...valid(), advanceDays: 30 }, 30).advanceDays,
    30,
  );
});

test("duration, step and reduced advance limits reject incompatible configurations", () => {
  for (const input of [
    { ...valid(), minimumMinutes: 0 },
    { ...valid(), maximumMinutes: 10 },
    { ...valid(), stepMinutes: 0 },
    { ...valid(), minimumMinutes: 31 },
    { ...valid(), maximumMinutes: 121 },
    { ...valid(), stepMinutes: NaN },
    { ...valid(), advanceDays: -1 },
    { ...valid(), advanceDays: 31 },
    { ...valid(), advanceDays: 0.5 },
    { ...valid(), maximumMinutes: Infinity },
  ])
    assert.throws(() => validateUnitCalendar(input, 30), {
      code: "INVALID_INPUT",
    });
  assert.throws(() => validateUnitCalendar(valid(), -1), {
    code: "INVALID_INPUT",
  });
});

test("weekly and dated intervals reject overlap, invalid bounds and duplicated dates", () => {
  for (const weekly of [
    [{ day: 0, startMinute: 0, endMinute: 60 }],
    [{ day: 8, startMinute: 0, endMinute: 60 }],
    [{ day: 1, startMinute: 60, endMinute: 60 }],
    [{ day: 1, startMinute: 1380, endMinute: 60 }],
    [{ day: 1, startMinute: -1, endMinute: 60 }],
    [{ day: 1, startMinute: 0, endMinute: 1441 }],
    [{ day: 1, startMinute: 0.5, endMinute: 60 }],
    [
      { day: 1, startMinute: 60, endMinute: 120 },
      { day: 1, startMinute: 90, endMinute: 150 },
    ],
  ])
    assert.throws(() => validateUnitCalendar({ ...valid(), weekly }, 30), {
      code: "INVALID_INPUT",
    });
  assert.throws(
    () =>
      validateUnitCalendar(
        {
          ...valid(),
          exceptions: [
            { date: "2026-10-19", intervals: [] },
            { date: "2026-10-19", intervals: [] },
          ],
        },
        30,
      ),
    { code: "INVALID_INPUT" },
  );
  assert.throws(
    () =>
      validateUnitCalendar(
        {
          ...valid(),
          exceptions: [
            {
              date: "2026-10-19",
              intervals: [
                { startMinute: 60, endMinute: 120 },
                { startMinute: 90, endMinute: 150 },
              ],
            },
          ],
        },
        30,
      ),
    { code: "INVALID_INPUT" },
  );
});

test("dated exceptions replace weekly opening including an explicit full-day closure", () => {
  const calendar = validateUnitCalendar(
    {
      ...valid(),
      exceptions: [
        {
          date: "2026-10-26",
          intervals: [{ startMinute: 900, endMinute: 960 }],
        },
        { date: "2026-10-19", intervals: [] },
      ],
    },
    30,
  );
  assert.deepEqual(localOpeningIntervals(calendar, "2026-10-19"), []);
  assert.deepEqual(localOpeningIntervals(calendar, "2026-10-26"), [
    { startMinute: 900, endMinute: 960 },
  ]);
  assert.deepEqual(localOpeningIntervals(calendar, "2026-11-02"), [
    { startMinute: 480, endMinute: 720 },
  ]);
  const returned = localOpeningIntervals(calendar, "2026-10-26");
  if (returned[0]) returned[0].endMinute = 1000;
  assert.equal(calendar.exceptions[1]?.intervals[0]?.endMinute, 960);
});

test("civil dates reject rollover and timestamps while accepting real leap days", () => {
  for (const date of [
    "2026-02-29",
    "2024-02-30",
    "2026-04-31",
    "2026-13-01",
    "2026-00-01",
    "2026-1-01",
    "2026-10-19T00:00:00Z",
    "0000-01-01",
  ])
    assert.throws(() => localDate(date), { code: "INVALID_INPUT" });
  assert.equal(
    localDate("2024-02-29").toISOString(),
    "2024-02-29T00:00:00.000Z",
  );
  assert.equal(localDate("0099-01-01").getUTCFullYear(), 99);
});
