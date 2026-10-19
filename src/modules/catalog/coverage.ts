import { Temporal } from "@js-temporal/polyfill";
import type { UnitCalendarInput } from "./calendar.ts";
import { utcOpeningIntervals } from "./opening.ts";

export function openingCoverage(calendar: UnitCalendarInput, timeZone: string) {
  const windows = new Map<string, Array<{ start: bigint; end: bigint }>>();
  const opening = (date: string) => {
    const cached = windows.get(date);
    if (cached) return cached;
    const result = utcOpeningIntervals(calendar, date, timeZone).map((row) => ({
      start: Temporal.Instant.from(row.start).epochNanoseconds,
      end: Temporal.Instant.from(row.end).epochNanoseconds,
    }));
    windows.set(date, result);
    return result;
  };
  const fullyOpenWeek = Array.from({ length: 7 }, (_, i) => i + 1).every(
    (day) => {
      const rows = calendar.weekly.filter((row) => row.day === day);
      let end = 0;
      for (const row of rows) {
        if (row.startMinute !== end) return false;
        end = row.endMinute;
      }
      return end === 1440;
    },
  );
  return (start: Temporal.Instant, end: Temporal.Instant): boolean => {
    if (fullyOpenWeek) {
      // A continuous weekly opening has no day-by-day work, even for a long
      // configured duration. Only dated exceptions can introduce a closure.
      const first = start.toZonedDateTimeISO(timeZone).toPlainDate().toString();
      const last = end.toZonedDateTimeISO(timeZone).toPlainDate().toString();
      for (const exception of calendar.exceptions) {
        if (exception.date < first || exception.date > last) continue;
        const day = Temporal.PlainDate.from(exception.date);
        const a = day.toZonedDateTime(timeZone).epochNanoseconds;
        const b = day
          .add({ days: 1 })
          .toZonedDateTime(timeZone).epochNanoseconds;
        const from = start.epochNanoseconds > a ? start.epochNanoseconds : a;
        const to = end.epochNanoseconds < b ? end.epochNanoseconds : b;
        if (
          from < to &&
          !opening(exception.date).some(
            (row) => row.start <= from && row.end >= to,
          )
        )
          return false;
      }
      return true;
    }
    let cursor = start.epochNanoseconds;
    while (cursor < end.epochNanoseconds) {
      const date = Temporal.Instant.fromEpochNanoseconds(cursor)
        .toZonedDateTimeISO(timeZone)
        .toPlainDate()
        .toString();
      const interval = opening(date).find(
        (row) => row.start <= cursor && cursor < row.end,
      );
      if (!interval) return false;
      cursor = interval.end;
    }
    return true;
  };
}
