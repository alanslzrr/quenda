import { Temporal } from "@js-temporal/polyfill";
import { HttpError } from "../../http/errors.ts";
import {
  localDate,
  localOpeningIntervals,
  type UnitCalendarInput,
  validateUnitCalendar,
} from "./calendar.ts";
import { openingCoverage } from "./coverage.ts";
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
  const covered = openingCoverage(calendar, input.timeZone);
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
