import { Temporal } from "@js-temporal/polyfill";
import { HttpError } from "../../http/errors.ts";
import {
  localDate,
  localOpeningIntervals,
  type UnitCalendarInput,
  validateUnitCalendar,
} from "./calendar.ts";
import { utcOpeningIntervals } from "./opening.ts";
import {
  describeInstant,
  possibleLocalInstants,
  withinAdvanceWindow,
  type ZonedInstant,
} from "./time.ts";

export interface CalendarSlot {
  start: ZonedInstant;
  end: ZonedInstant;
  durationMinutes: number;
}
export function calendarSlots(input: {
  calendar: UnitCalendarInput;
  date: string;
  timeZone: string;
  durationMinutes: number;
  municipalAdvanceDays: number;
  now: string;
}): CalendarSlot[] {
  const calendar = validateUnitCalendar(
    input.calendar,
    input.municipalAdvanceDays,
  );
  localDate(input.date);
  const duration = input.durationMinutes;
  if (
    !Number.isSafeInteger(duration) ||
    duration < calendar.minimumMinutes ||
    duration > calendar.maximumMinutes ||
    duration % calendar.stepMinutes !== 0
  )
    throw new HttpError("INVALID_INPUT");
  describeInstant(input.now, input.timeZone);
  const windows = new Map<string, Array<{ start: bigint; end: bigint }>>();
  const opening = (date: string) => {
    const cached = windows.get(date);
    if (cached) return cached;
    const result = utcOpeningIntervals(calendar, date, input.timeZone).map(
      (row) => ({
        start: Temporal.Instant.from(row.start).epochNanoseconds,
        end: Temporal.Instant.from(row.end).epochNanoseconds,
      }),
    );
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
  const covered = (start: Temporal.Instant, end: Temporal.Instant): boolean => {
    if (fullyOpenWeek) {
      // A continuous weekly opening has no day-by-day work, even for a long
      // configured duration. Only dated exceptions can introduce a closure.
      const first = start
        .toZonedDateTimeISO(input.timeZone)
        .toPlainDate()
        .toString();
      const last = end
        .toZonedDateTimeISO(input.timeZone)
        .toPlainDate()
        .toString();
      for (const exception of calendar.exceptions) {
        if (exception.date < first || exception.date > last) continue;
        const day = Temporal.PlainDate.from(exception.date);
        const a = day.toZonedDateTime(input.timeZone).epochNanoseconds;
        const b = day
          .add({ days: 1 })
          .toZonedDateTime(input.timeZone).epochNanoseconds;
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
        .toZonedDateTimeISO(input.timeZone)
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
  const result = new Map<string, CalendarSlot>();
  for (const interval of localOpeningIntervals(calendar, input.date)) {
    // Start-grid origin is the beginning of each continuous civil opening.
    for (
      let minute = interval.startMinute;
      minute < interval.endMinute;
      minute += calendar.stepMinutes
    ) {
      for (const start of possibleLocalInstants(
        input.date,
        minute,
        input.timeZone,
      )) {
        if (
          !withinAdvanceWindow(
            start.utc,
            input.now,
            input.timeZone,
            input.municipalAdvanceDays,
            calendar.advanceDays,
          )
        )
          continue;
        const instant = Temporal.Instant.from(start.utc);
        const end = instant.add({ minutes: duration });
        if (covered(instant, end))
          result.set(start.utc, {
            start,
            end: describeInstant(end.toString(), input.timeZone),
            durationMinutes: duration,
          });
      }
    }
  }
  return [...result.values()].sort((a, b) =>
    a.start.utc.localeCompare(b.start.utc),
  );
}
