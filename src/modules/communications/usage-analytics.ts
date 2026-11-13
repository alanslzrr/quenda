import { Temporal } from "@js-temporal/polyfill";
import { HttpError } from "../../http/errors.ts";
import {
  intersect,
  interval,
  type MetricUnit,
  type Range,
  unitAvailability,
} from "./indicators.ts";

export type Granularity = "day" | "week" | "month";

export interface AnalyticsUnitInfo {
  name: string;
  facilityId: string;
  facilityName: string;
}

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

/** Days for a day series up to a month, weeks up to half a year, then months. */
export function defaultGranularity(from: string, to: string): Granularity {
  const days = Temporal.PlainDate.from(from).until(
    Temporal.PlainDate.from(to),
  ).days;
  return days <= 31 ? "day" : days <= 183 ? "week" : "month";
}

/**
 * Local-date buckets covering [from,to): whole days, ISO weeks starting on
 * Monday or calendar months. The first and last buckets are clipped to the
 * period, so they can be shorter.
 */
function buckets(
  from: Temporal.PlainDate,
  to: Temporal.PlainDate,
  granularity: Granularity,
) {
  const result: Array<{ from: Temporal.PlainDate; to: Temporal.PlainDate }> =
    [];
  let cursor = from;
  while (Temporal.PlainDate.compare(cursor, to) < 0) {
    const next =
      granularity === "day"
        ? cursor.add({ days: 1 })
        : granularity === "week"
          ? cursor.add({ days: 8 - cursor.dayOfWeek })
          : cursor.with({ day: 1 }).add({ months: 1 });
    const end = Temporal.PlainDate.compare(next, to) < 0 ? next : to;
    result.push({ from: cursor, to: end });
    cursor = end;
  }
  return result;
}

/**
 * Index of the last bucket that starts at or before the instant. `bounds` holds
 * the start of every bucket followed by the period end.
 */
function bucketOf(bounds: bigint[], instant: bigint) {
  let low = 0,
    high = bounds.length - 2;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if ((bounds[middle] as bigint) <= instant) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** Adds the part of a range that falls in each bucket. */
function addByBucket(totals: bigint[], bounds: bigint[], range: Range) {
  for (let n = bucketOf(bounds, range.start); n < totals.length; n++) {
    const start = bounds[n] as bigint,
      end = bounds[n + 1] as bigint;
    if (start >= range.end) break;
    const piece = intersect(range, { start, end });
    if (piece) totals[n] = (totals[n] as bigint) + (piece.end - piece.start);
  }
}

/**
 * Usage analysis of a period beyond the basic indicators: the same totals,
 * their evolution by day, week or month, occupancy by weekday and hour and by
 * unit, cancellations, booking lead time and recorded arrivals. Only
 * aggregates leave this function.
 */
export function usageAnalytics(input: {
  from: string;
  to: string;
  timeZone: string;
  asOf: string;
  units: MetricUnit[];
  reservations: AnalyticsReservation[];
  unitInfo?: Record<string, AnalyticsUnitInfo>;
  granularity?: Granularity | undefined;
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
    const granularity =
      input.granularity ?? defaultGranularity(input.from, input.to);
    const slots = buckets(from, to, granularity);
    const bounds = [
      ...slots.map(
        (slot) => slot.from.toZonedDateTime(input.timeZone).epochNanoseconds,
      ),
      period.end,
    ];
    const empty = () => slots.map(() => 0n);
    const counts = () => slots.map(() => 0);
    const series = {
      offered: empty(),
      reserved: empty(),
      reservations: counts(),
      cancelled: counts(),
    };
    const offeredCells = new Map<number, bigint>();
    const reservedCells = new Map<number, bigint>();
    if (new Set(input.units.map((unit) => unit.id)).size !== input.units.length)
      throw new HttpError("INVALID_INPUT");
    const byUnit = new Map(
      input.units.map((unit) => [
        unit.id,
        {
          offered: 0n,
          reserved: 0n,
          reservations: 0,
          cancelled: 0,
          offeredSeries: empty(),
          reservedSeries: empty(),
        },
      ]),
    );
    for (const unit of input.units)
      for (const range of unitAvailability(unit, period, to, input.timeZone)) {
        addByHour(offeredCells, range, input.timeZone);
        addByBucket(series.offered, bounds, range);
        const totals = byUnit.get(unit.id);
        if (totals) {
          totals.offered += range.end - range.start;
          addByBucket(totals.offeredSeries, bounds, range);
        }
      }
    const lead = {
      lessThanOneDay: 0,
      oneToThreeDays: 0,
      threeToSevenDays: 0,
      sevenToFourteenDays: 0,
      fourteenDaysOrMore: 0,
    };
    const status = { CONFIRMADA: 0, CANCELADA: 0, FINALIZADA: 0 };
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
      if (!["CONFIRMADA", "CANCELADA"].includes(booking.status))
        throw new HttpError("INVALID_INPUT");
      if (booking.status === "CONFIRMADA" && clipped) {
        totals.reserved += clipped.end - clipped.start;
        addByHour(reservedCells, clipped, input.timeZone);
        addByBucket(series.reserved, bounds, clipped);
        addByBucket(totals.reservedSeries, bounds, clipped);
      }
      // Counts follow the basic indicators: a reservation belongs to the period it starts in.
      if (range.start < period.start || range.start >= period.end) continue;
      counted++;
      totals.reservations++;
      const slot = bucketOf(bounds, range.start);
      series.reservations[slot] = (series.reservations[slot] ?? 0) + 1;
      status[
        booking.status === "CANCELADA"
          ? "CANCELADA"
          : range.end <= asOf
            ? "FINALIZADA"
            : "CONFIRMADA"
      ]++;
      const advance =
        range.start - Temporal.Instant.from(booking.createdAt).epochNanoseconds;
      if (advance < day) lead.lessThanOneDay++;
      else if (advance < 3n * day) lead.oneToThreeDays++;
      else if (advance < 7n * day) lead.threeToSevenDays++;
      else if (advance < 14n * day) lead.sevenToFourteenDays++;
      else lead.fourteenDaysOrMore++;
      if (booking.status === "CANCELADA") {
        cancelled++;
        totals.cancelled++;
        series.cancelled[slot] = (series.cancelled[slot] ?? 0) + 1;
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
    const offered = [...byUnit.values()].reduce(
        (sum, u) => sum + u.offered,
        0n,
      ),
      reserved = [...byUnit.values()].reduce((sum, u) => sum + u.reserved, 0n);
    return {
      from: input.from,
      to: input.to,
      timeZone: input.timeZone,
      asOf: Temporal.Instant.from(input.asOf).toString(),
      granularity,
      summary: {
        reservations: status,
        reservedMinutes: minutes(reserved),
        offeredMinutes: minutes(offered),
        occupancyPercent: percent(minutes(reserved), minutes(offered)),
      },
      series: slots.map((slot, n) => {
        const offeredMinutes = minutes(series.offered[n] ?? 0n),
          reservedMinutes = minutes(series.reserved[n] ?? 0n);
        return {
          from: slot.from.toString(),
          to: slot.to.toString(),
          offeredMinutes,
          reservedMinutes,
          occupancyPercent: percent(reservedMinutes, offeredMinutes),
          reservations: series.reservations[n] ?? 0,
          cancelled: series.cancelled[n] ?? 0,
        };
      }),
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
      units: [...byUnit].map(([unitId, totals]) => {
        const info = input.unitInfo?.[unitId];
        return {
          unitId,
          name: info?.name ?? null,
          facilityId: info?.facilityId ?? null,
          facilityName: info?.facilityName ?? null,
          offeredMinutes: minutes(totals.offered),
          reservedMinutes: minutes(totals.reserved),
          occupancyPercent: percent(
            minutes(totals.reserved),
            minutes(totals.offered),
          ),
          reservations: totals.reservations,
          cancelled: totals.cancelled,
          // Occupancy per series bucket, for a small trend line.
          trend: totals.offeredSeries.map((value, n) =>
            percent(minutes(totals.reservedSeries[n] ?? 0n), minutes(value)),
          ),
        };
      }),
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
