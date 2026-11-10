import { Temporal } from "@js-temporal/polyfill";
import { HttpError } from "../../http/errors.ts";
import {
  type UnitCalendarInput,
  utcOpeningIntervals,
} from "../catalog/index.ts";

export interface MetricInterval {
  start: string;
  end: string;
}
export interface MetricUnit {
  id: string;
  // Effective, published calendar slices, already restricted to this unit.
  calendars: Array<MetricInterval & { calendar: UnitCalendarInput }>;
  closures: MetricInterval[];
}
export interface MetricReservation extends MetricInterval {
  unitId: string;
  status: "CONFIRMADA" | "CANCELADA";
}
export type Range = { start: bigint; end: bigint };
const minute = 60_000_000_000n;
export function interval(value: MetricInterval): Range {
  const start = Temporal.Instant.from(value.start).epochNanoseconds;
  const end = Temporal.Instant.from(value.end).epochNanoseconds;
  if (start >= end) throw new HttpError("INVALID_INPUT");
  return { start, end };
}
export function intersect(a: Range, b: Range): Range | null {
  const start = a.start > b.start ? a.start : b.start,
    end = a.end < b.end ? a.end : b.end;
  return start < end ? { start, end } : null;
}
function union(values: Range[]): Range[] {
  const result: Range[] = [];
  for (const current of [...values].sort((a, b) =>
    a.start < b.start ? -1 : a.start > b.start ? 1 : 0,
  )) {
    const previous = result.at(-1);
    if (previous && previous.end >= current.start)
      previous.end = previous.end > current.end ? previous.end : current.end;
    else result.push({ ...current });
  }
  return result;
}
/**
 * The bookable time of a unit inside the period: its published opening hours
 * minus closures, as sorted, disjoint ranges.
 */
export function unitAvailability(
  unit: MetricUnit,
  period: Range,
  to: Temporal.PlainDate,
  timeZone: string,
): Range[] {
  const windows: Range[] = [];
  const slices = unit.calendars
    .map((value) => ({ value, range: interval(value) }))
    .sort((a, b) => (a.range.start < b.range.start ? -1 : 1));
  for (let n = 0; n < slices.length; n++) {
    const slice = slices[n];
    if (!slice) continue;
    const previous = slices[n - 1];
    if (previous && previous.range.end > slice.range.start)
      throw new HttpError("INVALID_INPUT");
    const effective = intersect(slice.range, period);
    if (!effective) continue;
    let date = Temporal.Instant.fromEpochNanoseconds(effective.start)
      .toZonedDateTimeISO(timeZone)
      .toPlainDate();
    while (Temporal.PlainDate.compare(date, to) < 0) {
      const dayStart = date.toZonedDateTime(timeZone).epochNanoseconds;
      if (dayStart >= effective.end) break;
      for (const opening of utcOpeningIntervals(
        slice.value.calendar,
        date.toString(),
        timeZone,
      )) {
        const clipped = intersect(interval(opening), effective);
        if (clipped) windows.push(clipped);
      }
      date = date.add({ days: 1 });
    }
  }
  const closures = union(unit.closures.map(interval));
  const result: Range[] = [];
  for (const opening of union(windows)) {
    let pieces = [opening];
    for (const closure of closures)
      pieces = pieces.flatMap((piece) => {
        if (!intersect(piece, closure)) return [piece];
        return [
          { start: piece.start, end: closure.start },
          { start: closure.end, end: piece.end },
        ].filter((rest) => rest.start < rest.end);
      });
    result.push(...pieces);
  }
  return result;
}
export function municipalIndicators(input: {
  from: string;
  to: string;
  timeZone: string;
  asOf: string;
  units: MetricUnit[];
  reservations: MetricReservation[];
}) {
  try {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(input.from) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(input.to) ||
      !input.timeZone ||
      /^[+-]/.test(input.timeZone)
    )
      throw new HttpError("INVALID_INPUT");
    const from = Temporal.PlainDate.from(input.from),
      to = Temporal.PlainDate.from(input.to);
    const days = from.until(to).days;
    if (days < 1 || days > 366) throw new HttpError("INVALID_INPUT");
    const period = {
      start: from.toZonedDateTime(input.timeZone).epochNanoseconds,
      end: to.toZonedDateTime(input.timeZone).epochNanoseconds,
    };
    const asOf = Temporal.Instant.from(input.asOf).epochNanoseconds;
    const ids = new Set(input.units.map((unit) => unit.id));
    if (ids.size !== input.units.length) throw new HttpError("INVALID_INPUT");
    let offered = 0n,
      reserved = 0n;
    const counts = { CONFIRMADA: 0, CANCELADA: 0, FINALIZADA: 0 };
    for (const unit of input.units)
      for (const range of unitAvailability(unit, period, to, input.timeZone))
        offered += range.end - range.start;
    for (const booking of input.reservations) {
      if (
        !ids.has(booking.unitId) ||
        !["CONFIRMADA", "CANCELADA"].includes(booking.status)
      )
        throw new HttpError("INVALID_INPUT");
      const range = interval(booking);
      if (range.start >= period.start && range.start < period.end) {
        const status =
          booking.status === "CANCELADA"
            ? "CANCELADA"
            : range.end <= asOf
              ? "FINALIZADA"
              : "CONFIRMADA";
        counts[status]++;
      }
      if (booking.status === "CONFIRMADA") {
        const clipped = intersect(range, period);
        if (clipped) reserved += clipped.end - clipped.start;
      }
    }
    return {
      from: input.from,
      to: input.to,
      timeZone: input.timeZone,
      asOf: Temporal.Instant.from(input.asOf).toString(),
      reservations: counts,
      reservedMinutes: Number(reserved) / Number(minute),
      offeredMinutes: Number(offered) / Number(minute),
      occupancyPercent:
        offered === 0n ? null : (Number(reserved) / Number(offered)) * 100,
    };
  } catch (error) {
    if (error instanceof RangeError) throw new HttpError("INVALID_INPUT");
    throw error;
  }
}
