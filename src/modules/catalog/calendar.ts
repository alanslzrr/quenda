import { HttpError } from "../../http/errors.ts";
import { civilDate } from "../../shared/civil-date.ts";

export interface LocalInterval {
  startMinute: number;
  endMinute: number;
}
export interface UnitCalendarInput {
  minimumMinutes: number;
  maximumMinutes: number;
  stepMinutes: number;
  advanceDays: number | null;
  weekly: Array<LocalInterval & { day: number }>;
  exceptions: Array<{ date: string; intervals: LocalInterval[] }>;
}

const integer = (value: number, minimum: number, maximum = 2147483647) =>
  Number.isSafeInteger(value) && value >= minimum && value <= maximum;

function invalid(): never {
  throw new HttpError("INVALID_INPUT");
}

export function localDate(date: string): Date {
  civilDate(date);
  const instant = new Date(`${date}T00:00:00.000Z`);
  if (
    !Number.isFinite(instant.getTime()) ||
    instant.toISOString().slice(0, 10) !== date
  )
    invalid();
  return instant;
}

function intervals(values: LocalInterval[]): LocalInterval[] {
  const sorted = values
    .map(({ startMinute, endMinute }) => {
      if (
        !integer(startMinute, 0, 1439) ||
        !integer(endMinute, 1, 1440) ||
        startMinute >= endMinute
      )
        invalid();
      return { startMinute, endMinute };
    })
    .sort((a, b) => a.startMinute - b.startMinute);
  for (let i = 1; i < sorted.length; i++) {
    const previous = sorted[i - 1];
    const current = sorted[i];
    if (previous && current && current.startMinute < previous.endMinute)
      invalid();
  }
  return sorted;
}

// Civil-time configuration only. UTC conversion must resolve DST gaps and folds
// using the municipality's IANA zone; these minutes are not elapsed durations.
export function validateUnitCalendar(
  input: UnitCalendarInput,
  municipalAdvanceDays: number,
): UnitCalendarInput {
  if (
    !integer(municipalAdvanceDays, 0) ||
    !integer(input.minimumMinutes, 1) ||
    !integer(input.maximumMinutes, 1) ||
    !integer(input.stepMinutes, 1) ||
    input.minimumMinutes > input.maximumMinutes ||
    input.minimumMinutes % input.stepMinutes !== 0 ||
    input.maximumMinutes % input.stepMinutes !== 0 ||
    (input.advanceDays !== null &&
      (!integer(input.advanceDays, 0) ||
        input.advanceDays > municipalAdvanceDays))
  )
    invalid();
  if (input.weekly.some((row) => !integer(row.day, 1, 7))) invalid();
  const weekly = Array.from({ length: 7 }, (_, index) => index + 1).flatMap(
    (day) =>
      intervals(input.weekly.filter((row) => row.day === day)).map(
        (interval) => ({ day, ...interval }),
      ),
  );
  const dates = new Set<string>();
  const exceptions = input.exceptions
    .map((exception) => {
      localDate(exception.date);
      if (dates.has(exception.date)) invalid();
      dates.add(exception.date);
      return {
        date: exception.date,
        intervals: intervals(exception.intervals),
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
  return {
    minimumMinutes: input.minimumMinutes,
    maximumMinutes: input.maximumMinutes,
    stepMinutes: input.stepMinutes,
    advanceDays: input.advanceDays,
    weekly,
    exceptions,
  };
}

export function localOpeningIntervals(
  calendar: UnitCalendarInput,
  date: string,
): LocalInterval[] {
  const instant = localDate(date);
  const exception = calendar.exceptions.find((item) => item.date === date);
  const day = instant.getUTCDay() || 7;
  const opening = exception
    ? exception.intervals
    : calendar.weekly.filter((item) => item.day === day);
  // Adjacent openings form one continuous interval. Reservations must still be
  // fully contained in an opening after timezone conversion.
  const merged: LocalInterval[] = [];
  for (const interval of intervals(opening)) {
    const last = merged.at(-1);
    if (last?.endMinute === interval.startMinute)
      last.endMinute = interval.endMinute;
    else merged.push({ ...interval });
  }
  return merged;
}
