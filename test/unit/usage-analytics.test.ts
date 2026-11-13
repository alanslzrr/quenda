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

test("usage analytics repeats the basic indicators and splits them over the series", () => {
  const units = [unit("a"), unit("b")];
  const reservations = [
    booking("a", "2030-01-07T07:00:00Z", "2030-01-07T08:30:00Z"),
    booking("a", "2030-01-08T07:00:00Z", "2030-01-08T08:00:00Z"),
    booking("b", "2030-01-09T07:00:00Z", "2030-01-09T08:00:00Z", {
      status: "CANCELADA",
      cancelledByHolder: true,
    }),
    // Starts the day before: its time inside the period counts, the booking does not.
    booking("b", "2030-01-06T22:00:00Z", "2030-01-07T08:00:00Z"),
    booking("b", "2030-01-12T08:00:00Z", "2030-01-12T09:00:00Z"),
  ];
  const input = {
    from: "2030-01-07",
    to: "2030-01-14",
    timeZone: "Europe/Madrid",
    asOf: "2030-01-11T00:00:00Z",
    units,
    unitInfo: {
      a: { name: "Pista 1", facilityId: "f", facilityName: "Pabellón" },
      b: { name: "Pista 2", facilityId: "f", facilityName: "Pabellón" },
    },
  };
  const result = usageAnalytics({ ...input, reservations });
  const basic = municipalIndicators({
    ...input,
    reservations: reservations.map(({ unitId, start, end, status }) => ({
      unitId,
      start,
      end,
      status,
    })),
  });
  assert.deepEqual(result.summary, {
    reservations: basic.reservations,
    reservedMinutes: basic.reservedMinutes,
    offeredMinutes: basic.offeredMinutes,
    occupancyPercent: basic.occupancyPercent,
  });

  // A week shows days; every day and unit adds up to the totals.
  assert.equal(result.granularity, "day");
  assert.equal(result.series.length, 7);
  assert.deepEqual(result.series[0], {
    from: "2030-01-07",
    to: "2030-01-08",
    offeredMinutes: 240,
    // 90 minutes in unit a, and 00:00-09:00 local of the overnight booking.
    reservedMinutes: 90 + 540,
    occupancyPercent: (630 / 240) * 100,
    reservations: 1,
    cancelled: 0,
  });
  assert.equal(result.series[2]?.cancelled, 1);
  const sum = (key: "offeredMinutes" | "reservedMinutes" | "reservations") =>
    result.series.reduce((total, slot) => total + slot[key], 0);
  assert.equal(sum("offeredMinutes"), basic.offeredMinutes);
  assert.equal(sum("reservedMinutes"), basic.reservedMinutes);
  assert.equal(sum("reservations"), result.cancellations.reservations);

  const b = result.units.find((u) => u.unitId === "b");
  assert.equal(b?.facilityName, "Pabellón");
  assert.equal(b?.reservations, 2);
  assert.equal(b?.cancelled, 1);
  assert.equal(b?.trend.length, 7);
  assert.equal(b?.trend[5], 50);
});

test("usage analytics groups long periods by ISO week or month, clipped to the period", () => {
  const base = {
    timeZone: "Europe/Madrid",
    asOf: "2030-01-01T00:00:00Z",
    units: [unit("a")],
    reservations: [
      // Wednesday 30 January, 08:00-09:00 local.
      booking("a", "2030-01-30T07:00:00Z", "2030-01-30T08:00:00Z"),
    ],
  };
  // Tuesday 1 January to Friday 1 March: about two months shows weeks that
  // start on Monday; the first and the last are shorter.
  const weeks = usageAnalytics({
    ...base,
    from: "2030-01-01",
    to: "2030-03-01",
  });
  assert.equal(weeks.granularity, "week");
  assert.deepEqual(
    weeks.series.slice(0, 2).map((slot) => [slot.from, slot.to]),
    [
      ["2030-01-01", "2030-01-07"],
      ["2030-01-07", "2030-01-14"],
    ],
  );
  assert.deepEqual(
    [weeks.series.at(-1)?.from, weeks.series.at(-1)?.to],
    ["2030-02-25", "2030-03-01"],
  );
  assert.equal(
    weeks.series.find((slot) => slot.reservations === 1)?.from,
    "2030-01-28",
  );

  const months = usageAnalytics({
    ...base,
    from: "2030-01-15",
    to: "2030-12-01",
  });
  assert.equal(months.granularity, "month");
  assert.deepEqual(
    months.series.slice(0, 2).map((slot) => [slot.from, slot.to]),
    [
      ["2030-01-15", "2030-02-01"],
      ["2030-02-01", "2030-03-01"],
    ],
  );
  assert.equal(months.series[0]?.reservedMinutes, 60);
  // 17 January days of two open hours.
  assert.equal(months.series[0]?.offeredMinutes, 17 * 120);

  const days = usageAnalytics({
    ...base,
    from: "2030-01-01",
    to: "2030-03-01",
    granularity: "day",
  });
  assert.equal(days.series.length, 59);
});
