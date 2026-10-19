import { Temporal } from "@js-temporal/polyfill";
import { HttpError } from "../../http/errors.ts";

type Interval = { start: string; end: string };
type Range = { start: bigint; end: bigint };
export interface MonthlyAggregateInput {
  month: string;
  timeZone: string;
  asOf: string;
  // Participants and effective unit assignments with reporting enabled in this month.
  participants: string[];
  scopes: Array<Interval & { tenantId: string; unitId: string }>;
  // Internal attributed projections; no account/subject identifiers leave this function.
  reservations: Array<
    Interval & {
      tenantId: string;
      unitId: string;
      reservationId: string;
      subjectId: string;
      released: boolean;
    }
  >;
}
function range(value: Interval): Range {
  const start = Temporal.Instant.from(value.start).epochNanoseconds;
  const end = Temporal.Instant.from(value.end).epochNanoseconds;
  if (start >= end) throw new HttpError("INVALID_INPUT");
  return { start, end };
}
function intersection(a: Range, b: Range): Range | null {
  const start = a.start > b.start ? a.start : b.start,
    end = a.end < b.end ? a.end : b.end;
  return start < end ? { start, end } : null;
}
function union(values: Range[]) {
  const merged: Range[] = [];
  for (const value of values.sort((a, b) =>
    a.start < b.start ? -1 : a.start > b.start ? 1 : 0,
  )) {
    const previous = merged.at(-1);
    if (previous && previous.end >= value.start)
      previous.end = previous.end > value.end ? previous.end : value.end;
    else merged.push({ ...value });
  }
  return merged;
}
// This is a threshold assessment, never authorization to publish or deliver a report.
export function assessMonthlyAggregate(input: MonthlyAggregateInput) {
  try {
    if (
      !/^\d{4}-\d{2}$/.test(input.month) ||
      !input.timeZone ||
      /^[+-]/.test(input.timeZone)
    )
      throw new HttpError("INVALID_INPUT");
    new Intl.DateTimeFormat("en", { timeZone: input.timeZone });
    const month = Temporal.PlainYearMonth.from(input.month).toPlainDate({
      day: 1,
    });
    const period = {
      start: month.toZonedDateTime(input.timeZone).epochNanoseconds,
      end: month.add({ months: 1 }).toZonedDateTime(input.timeZone)
        .epochNanoseconds,
    };
    if (Temporal.Instant.from(input.asOf).epochNanoseconds < period.end)
      throw new HttpError("INVALID_INPUT");
    const subjects = new Map(
      input.participants.map((tenant) => [tenant, new Set<string>()]),
    );
    if (
      subjects.size !== input.participants.length ||
      input.participants.some((p) => !p)
    )
      throw new HttpError("INVALID_INPUT");
    const scopes = new Map<string, Range[]>();
    const key = (tenant: string, unit: string) =>
      JSON.stringify([tenant, unit]);
    for (const scope of input.scopes) {
      if (!subjects.has(scope.tenantId) || !scope.unitId)
        throw new HttpError("INVALID_INPUT");
      const clipped = intersection(range(scope), period);
      if (clipped) {
        const k = key(scope.tenantId, scope.unitId);
        scopes.set(k, [...(scopes.get(k) ?? []), clipped]);
      }
    }
    for (const [k, values] of scopes) scopes.set(k, union(values));
    const seen = new Set<string>(),
      totalSubjects = new Set<string>();
    let count = 0,
      minutes = 0n;
    for (const booking of input.reservations) {
      const id = JSON.stringify([booking.tenantId, booking.reservationId]);
      if (
        !booking.reservationId ||
        !booking.subjectId ||
        !booking.unitId ||
        !subjects.has(booking.tenantId) ||
        seen.has(id)
      )
        throw new HttpError("INVALID_INPUT");
      seen.add(id);
      const interval = range(booking);
      if (booking.released) continue;
      const windows = scopes.get(key(booking.tenantId, booking.unitId)) ?? [];
      const covered = windows
        .map((w) => intersection(w, interval))
        .filter((r): r is Range => r !== null);
      if (!covered.length) continue;
      subjects.get(booking.tenantId)?.add(booking.subjectId);
      totalSubjects.add(booking.subjectId);
      if (
        windows.some((w) => w.start <= interval.start && interval.start < w.end)
      )
        count++;
      for (const part of covered) minutes += part.end - part.start;
    }
    if (
      subjects.size === 0 ||
      totalSubjects.size < 10 ||
      [...subjects.values()].some((s) => s.size < 10)
    )
      return { status: "NOT_PUBLISHABLE" as const };
    return {
      status: "THRESHOLD_MET" as const,
      reservations: count,
      reservedMinutes: Number(minutes) / 60_000_000_000,
    };
  } catch (error) {
    if (error instanceof RangeError) throw new HttpError("INVALID_INPUT");
    throw error;
  }
}
