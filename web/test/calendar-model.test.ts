import assert from "node:assert/strict";
import test from "node:test";
import {
  admissibleDuration,
  calendarProblem,
} from "../src/features/municipal/calendar-model.ts";

const base = {
  minimumMinutes: 30,
  maximumMinutes: 120,
  stepMinutes: 30,
  advanceDays: null,
  weekly: [{ day: 1, startMinute: 540, endMinute: 780 }],
  exceptions: [],
};

test("a coherent calendar has no problem", () => {
  assert.equal(calendarProblem(base), null);
});

test("limits that are not whole multiples of the step are explained", () => {
  assert.equal(calendarProblem({ ...base, maximumMinutes: 100 }), "step");
  assert.equal(calendarProblem({ ...base, minimumMinutes: 150 }), "range");
  assert.equal(calendarProblem({ ...base, stepMinutes: 0 }), "range");
  assert.equal(calendarProblem({ ...base, advanceDays: -1 }), "advance");
});

test("weekly and exception intervals may touch but not overlap on one day", () => {
  const touching = [
    { day: 2, startMinute: 540, endMinute: 600 },
    { day: 2, startMinute: 600, endMinute: 660 },
  ];
  assert.equal(calendarProblem({ ...base, weekly: touching }), null);
  assert.equal(
    calendarProblem({
      ...base,
      weekly: [
        { day: 2, startMinute: 540, endMinute: 630 },
        { day: 2, startMinute: 600, endMinute: 660 },
      ],
    }),
    "overlap",
  );
  assert.equal(
    calendarProblem({
      ...base,
      weekly: [
        { day: 2, startMinute: 540, endMinute: 630 },
        { day: 3, startMinute: 600, endMinute: 660 },
      ],
    }),
    null,
  );
  assert.equal(
    calendarProblem({
      ...base,
      exceptions: [
        {
          date: "2026-12-24",
          intervals: [
            { startMinute: 600, endMinute: 700 },
            { startMinute: 650, endMinute: 720 },
          ],
        },
      ],
    }),
    "exceptionOverlap",
  );
});

test("a typed duration is committed only when the server would admit it", () => {
  assert.equal(admissibleDuration("60", base), 60);
  for (const text of ["", "0", "-30", "45", "150", "12.5", "1e2", "30 "])
    assert.equal(admissibleDuration(text, base), null, text);
});
