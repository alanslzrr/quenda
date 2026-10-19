import assert from "node:assert/strict";
import test from "node:test";
import type { UnitCalendarInput } from "../../src/modules/catalog/index.ts";
import { municipalIndicators } from "../../src/modules/communications/index.ts";

const calendar = (startMinute = 0, endMinute = 1440): UnitCalendarInput => ({
  minimumMinutes: 30,
  maximumMinutes: 120,
  stepMinutes: 30,
  advanceDays: null,
  weekly: Array.from({ length: 7 }, (_, n) => ({
    day: n + 1,
    startMinute,
    endMinute,
  })),
  exceptions: [],
});
const slice = {
  start: "2020-01-01T00:00:00Z",
  end: "2040-01-01T00:00:00Z",
  calendar: calendar(),
};
test("municipal indicators clip intervals and preserve historical calendars without double-counting closures", () => {
  const input = {
    from: "2030-01-01",
    to: "2030-01-03",
    timeZone: "UTC",
    asOf: "2030-01-02T15:00:00Z",
    units: [
      {
        id: "unit",
        calendars: [
          { ...slice, end: "2030-01-01T12:00:00Z" },
          {
            ...slice,
            start: "2030-01-01T12:00:00Z",
            calendar: calendar(720, 840),
          },
        ],
        closures: [
          { start: "2030-01-01T11:00:00Z", end: "2030-01-01T13:00:00Z" },
          { start: "2030-01-01T12:00:00Z", end: "2030-01-01T13:30:00Z" },
        ],
      },
    ],
    reservations: [
      {
        unitId: "unit",
        status: "CONFIRMADA" as const,
        start: "2029-12-31T23:00:00Z",
        end: "2030-01-01T01:00:00Z",
      },
      {
        unitId: "unit",
        status: "CONFIRMADA" as const,
        start: "2030-01-01T10:00:00Z",
        end: "2030-01-01T12:00:00Z",
      },
      {
        unitId: "unit",
        status: "CANCELADA" as const,
        start: "2030-01-02T13:00:00Z",
        end: "2030-01-02T14:00:00Z",
      },
      {
        unitId: "unit",
        status: "CONFIRMADA" as const,
        start: "2030-01-02T16:00:00Z",
        end: "2030-01-02T17:00:00Z",
      },
      {
        unitId: "unit",
        status: "CONFIRMADA" as const,
        start: "2030-01-03T00:00:00Z",
        end: "2030-01-03T01:00:00Z",
      },
    ],
  };
  const saved = structuredClone(input),
    result = municipalIndicators(input);
  assert.deepEqual(result.reservations, {
    CONFIRMADA: 1,
    CANCELADA: 1,
    FINALIZADA: 1,
  });
  assert.equal(result.offeredMinutes, 810);
  assert.equal(result.reservedMinutes, 240);
  assert.equal(result.occupancyPercent, (240 / 810) * 100);
  assert.deepEqual(input, saved);
});
test("offered minutes follow actual DST duration and do not bridge repeated partial openings", () => {
  for (const [from, to, minutes] of [
    ["2030-03-31", "2030-04-01", 1380],
    ["2030-10-27", "2030-10-28", 1500],
  ] as const) {
    const report = municipalIndicators({
      from,
      to,
      timeZone: "Europe/Madrid",
      asOf: "2031-01-01T00:00:00Z",
      units: [{ id: "unit", calendars: [slice], closures: [] }],
      reservations: [],
    });
    assert.equal(report.offeredMinutes, minutes);
  }
  const report = municipalIndicators({
    from: "2030-10-27",
    to: "2030-10-28",
    timeZone: "Europe/Madrid",
    asOf: "2031-01-01T00:00:00Z",
    units: [
      {
        id: "unit",
        calendars: [{ ...slice, calendar: calendar(135, 165) }],
        closures: [
          { start: "2030-10-27T00:20:00Z", end: "2030-10-27T00:25:00Z" },
        ],
      },
    ],
    reservations: [],
  });
  assert.equal(report.offeredMinutes, 55);
});
test("zero offering is not applicable; exceptions, multiple units and date validation are explicit", () => {
  const input = {
    from: "2030-01-01",
    to: "2030-01-02",
    timeZone: "UTC",
    asOf: "2031-01-01T00:00:00Z",
    units: [
      {
        id: "unit",
        calendars: [
          {
            ...slice,
            calendar: {
              ...calendar(),
              exceptions: [{ date: "2030-01-01", intervals: [] }],
            },
          },
        ],
        closures: [],
      },
    ],
    reservations: [],
  };
  assert.equal(municipalIndicators(input).occupancyPercent, null);
  assert.equal(municipalIndicators(input).offeredMinutes, 0);
  assert.equal(
    municipalIndicators({
      ...input,
      units: [
        { id: "a", calendars: [slice], closures: [] },
        { id: "b", calendars: [slice], closures: [] },
      ],
    }).offeredMinutes,
    2880,
  );
  for (const patch of [
    { from: "2030-02-30" },
    { to: "2030-01-01" },
    { to: "2032-01-01" },
    { timeZone: "+01:00" },
    { timeZone: "Invalid/Zone" },
    { units: [input.units[0], input.units[0]] },
  ])
    assert.throws(
      () =>
        municipalIndicators({ ...input, ...patch } as Parameters<
          typeof municipalIndicators
        >[0]),
      { code: "INVALID_INPUT" },
    );
  assert.throws(
    () =>
      municipalIndicators({
        ...input,
        units: [{ id: "unit", calendars: [slice, slice], closures: [] }],
      }),
    { code: "INVALID_INPUT" },
  );
});
