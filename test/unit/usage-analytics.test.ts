import assert from "node:assert/strict";
import test from "node:test";
import type { UnitCalendarInput } from "../../src/modules/catalog/index.ts";
import { municipalIndicators } from "../../src/modules/communications/indicators.ts";
import { usageAnalytics } from "../../src/modules/communications/usage-analytics.ts";

// Open 08:00-10:00 local time every day; Madrid is UTC+1 in January.
const calendar: UnitCalendarInput = {
  minimumMinutes: 30,
  maximumMinutes: 120,
  stepMinutes: 30,
  advanceDays: null,
  weekly: Array.from({ length: 7 }, (_, n) => ({
    day: n + 1,
    startMinute: 480,
    endMinute: 600,
  })),
  exceptions: [],
};
const unit = (id: string) => ({
  id,
  calendars: [
    { start: "2020-01-01T00:00:00Z", end: "2040-01-01T00:00:00Z", calendar },
  ],
  closures: [] as { start: string; end: string }[],
});
const booking = (
  unitId: string,
  start: string,
  end: string,
  extra: Partial<{
    status: "CONFIRMADA" | "CANCELADA";
    createdAt: string;
    arrived: boolean;
    cancelledByHolder: boolean | null;
  }> = {},
) => ({
  unitId,
  start,
  end,
  status: "CONFIRMADA" as const,
  createdAt: "2029-12-01T00:00:00Z",
  arrived: false,
  cancelledByHolder: null,
  ...extra,
});

test("usage analytics splits time by local weekday and hour and agrees with the basic indicators", () => {
  const units = [unit("a"), unit("b")];
  // Monday 7 January 2030, 08:00-09:30 local, booked six days earlier and attended.
  const attended = booking(
    "a",
    "2030-01-07T07:00:00Z",
    "2030-01-07T08:30:00Z",
    {
      createdAt: "2030-01-01T07:00:00Z",
      arrived: true,
    },
  );
  const reservations = [
    attended,
    // Tuesday 08:00-09:00, booked twelve hours earlier, no arrival recorded.
    booking("a", "2030-01-08T07:00:00Z", "2030-01-08T08:00:00Z", {
      createdAt: "2030-01-07T19:00:00Z",
    }),
    // Cancelled by the holder and by staff: no reserved time.
    booking("b", "2030-01-09T07:00:00Z", "2030-01-09T08:00:00Z", {
      status: "CANCELADA",
      cancelledByHolder: true,
    }),
    booking("b", "2030-01-10T07:00:00Z", "2030-01-10T08:00:00Z", {
      status: "CANCELADA",
      cancelledByHolder: false,
    }),
    // Starts before the period: its time inside counts, it is not counted itself.
    booking("b", "2030-01-06T22:00:00Z", "2030-01-07T08:00:00Z"),
    // Future: confirmed, not finished.
    booking("b", "2030-01-12T08:00:00Z", "2030-01-12T09:00:00Z"),
  ];
  const input = {
    from: "2030-01-07",
    to: "2030-01-14",
    timeZone: "Europe/Madrid",
    asOf: "2030-01-11T00:00:00Z",
    units,
  };
  const result = usageAnalytics({ ...input, reservations });

  // Two open hours (08 and 09) on every weekday, plus Monday 00-07: the overnight
  // reservation is reserved time outside opening hours, as in the basic indicators.
  assert.equal(result.weekdayHours.length, 14 + 8);
  assert.equal(
    result.weekdayHours.filter((c) => c.offeredMinutes === 0).length,
    8,
  );
  const cell = (weekday: number, hour: number) =>
    result.weekdayHours.find((c) => c.weekday === weekday && c.hour === hour);
  assert.deepEqual(cell(1, 8), {
    weekday: 1,
    hour: 8,
    offeredMinutes: 120,
    reservedMinutes: 120,
    occupancyPercent: 100,
  });
  assert.equal(cell(1, 9)?.reservedMinutes, 30);
  assert.equal(cell(2, 8)?.reservedMinutes, 60);
  assert.equal(cell(3, 8)?.reservedMinutes, 0);
  assert.equal(cell(6, 9)?.reservedMinutes, 60);

  const basic = municipalIndicators({
    ...input,
    reservations: reservations.map(({ unitId, start, end, status }) => ({
      unitId,
      start,
      end,
      status,
    })),
  });
  const total = (key: "offeredMinutes" | "reservedMinutes") =>
    result.units.reduce((sum, u) => sum + u[key], 0);
  assert.equal(total("offeredMinutes"), basic.offeredMinutes);
  assert.equal(total("reservedMinutes"), basic.reservedMinutes);
  assert.equal(
    result.weekdayHours.reduce((sum, c) => sum + c.reservedMinutes, 0),
    basic.reservedMinutes,
  );

  assert.deepEqual(result.cancellations, {
    reservations: 5,
    cancelled: 2,
    byHolder: 1,
    administrative: 1,
    cancelledPercent: 40,
  });
  assert.deepEqual(result.leadTime, {
    lessThanOneDay: 1,
    oneToThreeDays: 0,
    threeToSevenDays: 1,
    sevenToFourteenDays: 0,
    fourteenDaysOrMore: 3,
  });
  assert.deepEqual(result.attendance, {
    finished: 2,
    arrived: 1,
    arrivedPercent: 50,
  });
});

test("usage analytics reports no rates without a denominator", () => {
  const result = usageAnalytics({
    from: "2030-01-07",
    to: "2030-01-08",
    timeZone: "UTC",
    asOf: "2030-01-01T00:00:00Z",
    units: [{ ...unit("a"), calendars: [] }],
    reservations: [],
  });
  assert.deepEqual(result.weekdayHours, []);
  assert.equal(result.units[0]?.occupancyPercent, null);
  assert.equal(result.cancellations.cancelledPercent, null);
  assert.equal(result.attendance.arrivedPercent, null);
  assert.throws(() =>
    usageAnalytics({
      from: "2030-01-07",
      to: "2030-01-07",
      timeZone: "UTC",
      asOf: "2030-01-01T00:00:00Z",
      units: [],
      reservations: [],
    }),
  );
});
