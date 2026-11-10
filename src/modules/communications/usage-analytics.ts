import { Temporal } from "@js-temporal/polyfill";
import { HttpError } from "../../http/errors.ts";
import {
  intersect,
  interval,
  type MetricUnit,
  type Range,
  unitAvailability,
} from "./indicators.ts";

export interface AnalyticsReservation {
  unitId: string;
  start: string;
  end: string;
  status: "CONFIRMADA" | "CANCELADA";
  createdAt: string;
  arrived: boolean;
  /** null unless cancelled; true when the holder cancelled it. */
  cancelledByHolder: boolean | null;
}

const minute = 60_000_000_000n;
const hour = 60n * minute;
const day = 24n * hour;
const minutes = (value: bigint) => Number(value) / Number(minute);
const percent = (part: number, whole: number) =>
  whole === 0 ? null : (part / whole) * 100;

/**
 * Adds a range to weekday×hour cells in local time. The cell key is
 * `weekday*24+hour` with ISO weekdays (1 = Monday).
 */
function addByHour(cells: Map<number, bigint>, range: Range, timeZone: string) {
  let cursor = range.start;
  while (cursor < range.end) {
    const local =
      Temporal.Instant.fromEpochNanoseconds(cursor).toZonedDateTimeISO(
        timeZone,
      );
    const next = local
      .round({ smallestUnit: "hour", roundingMode: "floor" })
      .add({ hours: 1 }).epochNanoseconds;
    const end = next < range.end ? next : range.end;
    const key = local.dayOfWeek * 24 + local.hour;
    cells.set(key, (cells.get(key) ?? 0n) + (end - cursor));
    cursor = end;
  }
}

/**
 * Usage analysis of a period beyond the basic indicators: occupancy by weekday
 * and hour and by unit, cancellations, booking lead time and recorded arrivals.
 * Only aggregates leave this function.
 */
export function usageAnalytics(input: {
  from: string;
  to: string;
  timeZone: string;
  asOf: string;
  units: MetricUnit[];
  reservations: AnalyticsReservation[];
  unitNames?: Record<string, string>;
}) {
  try {
    const from = Temporal.PlainDate.from(input.from),
      to = Temporal.PlainDate.from(input.to);
    const days = from.until(to).days;
    if (days < 1 || days > 366) throw new HttpError("INVALID_INPUT");
    const period = {
      start: from.toZonedDateTime(input.timeZone).epochNanoseconds,
      end: to.toZonedDateTime(input.timeZone).epochNanoseconds,
    };
    const asOf = Temporal.Instant.from(input.asOf).epochNanoseconds;
    const offeredCells = new Map<number, bigint>();
    const reservedCells = new Map<number, bigint>();
    const byUnit = new Map(
      input.units.map((unit) => [unit.id, { offered: 0n, reserved: 0n }]),
    );
    for (const unit of input.units)
      for (const range of unitAvailability(unit, period, to, input.timeZone)) {
        addByHour(offeredCells, range, input.timeZone);
        const totals = byUnit.get(unit.id);
        if (totals) totals.offered += range.end - range.start;
      }
    const lead = {
      lessThanOneDay: 0,
      oneToThreeDays: 0,
      threeToSevenDays: 0,
      sevenToFourteenDays: 0,
      fourteenDaysOrMore: 0,
    };
    let counted = 0,
      cancelled = 0,
      byHolder = 0,
      finished = 0,
      arrived = 0;
    for (const booking of input.reservations) {
      const totals = byUnit.get(booking.unitId);
      if (!totals) throw new HttpError("INVALID_INPUT");
      const range = interval(booking);
      const clipped = intersect(range, period);
      if (booking.status === "CONFIRMADA" && clipped) {
        totals.reserved += clipped.end - clipped.start;
        addByHour(reservedCells, clipped, input.timeZone);
      }
      // Counts follow the basic indicators: a reservation belongs to the period it starts in.
      if (range.start < period.start || range.start >= period.end) continue;
      counted++;
      const advance =
        range.start - Temporal.Instant.from(booking.createdAt).epochNanoseconds;
      if (advance < day) lead.lessThanOneDay++;
      else if (advance < 3n * day) lead.oneToThreeDays++;
      else if (advance < 7n * day) lead.threeToSevenDays++;
      else if (advance < 14n * day) lead.sevenToFourteenDays++;
      else lead.fourteenDaysOrMore++;
      if (booking.status === "CANCELADA") {
        cancelled++;
        if (booking.cancelledByHolder) byHolder++;
        continue;
      }
      if (range.end <= asOf) {
        finished++;
        if (booking.arrived) arrived++;
      }
    }
    const keys = [
      ...new Set([...offeredCells.keys(), ...reservedCells.keys()]),
    ].sort((a, b) => a - b);
    return {
      from: input.from,
      to: input.to,
      timeZone: input.timeZone,
      asOf: Temporal.Instant.from(input.asOf).toString(),
      weekdayHours: keys.map((key) => {
        const offered = minutes(offeredCells.get(key) ?? 0n),
          reserved = minutes(reservedCells.get(key) ?? 0n);
        return {
          weekday: Math.floor(key / 24),
          hour: key % 24,
          offeredMinutes: offered,
          reservedMinutes: reserved,
          occupancyPercent: percent(reserved, offered),
        };
      }),
      units: [...byUnit].map(([unitId, totals]) => ({
        unitId,
        name: input.unitNames?.[unitId] ?? null,
        offeredMinutes: minutes(totals.offered),
        reservedMinutes: minutes(totals.reserved),
        occupancyPercent: percent(
          minutes(totals.reserved),
          minutes(totals.offered),
        ),
      })),
      cancellations: {
        reservations: counted,
        cancelled,
        byHolder,
        administrative: cancelled - byHolder,
        cancelledPercent: percent(cancelled, counted),
      },
      leadTime: lead,
      attendance: {
        finished,
        arrived,
        arrivedPercent: percent(arrived, finished),
      },
    };
  } catch (error) {
    if (error instanceof RangeError) throw new HttpError("INVALID_INPUT");
    throw error;
  }
}
