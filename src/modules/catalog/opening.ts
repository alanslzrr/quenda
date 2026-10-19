import { Temporal } from "@js-temporal/polyfill";
import { HttpError } from "../../http/errors.ts";
import {
  localDate,
  localOpeningIntervals,
  type UnitCalendarInput,
} from "./calendar.ts";
import { describeInstant } from "./time.ts";

export interface UtcOpening {
  start: string;
  end: string;
}
const minuteNs = 60_000_000_000n;

// Intersect civil openings with each constant-offset segment of the actual day.
// Resolving just the earliest start and latest end would open the gap between
// two repeated partial-hour windows during a backward transition.
export function utcOpeningIntervals(
  calendar: UnitCalendarInput,
  date: string,
  timeZone: string,
): UtcOpening[] {
  localDate(date);
  describeInstant("2000-01-01T00:00:00Z", timeZone);
  try {
    const day = Temporal.PlainDate.from(date);
    const start = day.toZonedDateTime(timeZone);
    if (!start.toPlainDate().equals(day)) return [];
    const end = day.add({ days: 1 }).toZonedDateTime(timeZone);
    const wallMidnight = day.toZonedDateTime("UTC").epochNanoseconds;
    const openings = localOpeningIntervals(calendar, date);
    const pieces: Array<{ start: bigint; end: bigint }> = [];
    let cursor = start;
    while (cursor.epochNanoseconds < end.epochNanoseconds) {
      const transition = cursor.getTimeZoneTransition("next");
      const segmentEnd =
        transition && transition.epochNanoseconds < end.epochNanoseconds
          ? transition.epochNanoseconds
          : end.epochNanoseconds;
      const offset = BigInt(cursor.offsetNanoseconds);
      for (const opening of openings) {
        const candidateStart =
          wallMidnight + BigInt(opening.startMinute) * minuteNs - offset;
        const candidateEnd =
          wallMidnight + BigInt(opening.endMinute) * minuteNs - offset;
        const a =
          candidateStart > cursor.epochNanoseconds
            ? candidateStart
            : cursor.epochNanoseconds;
        const b = candidateEnd < segmentEnd ? candidateEnd : segmentEnd;
        if (a < b) pieces.push({ start: a, end: b });
      }
      cursor =
        Temporal.Instant.fromEpochNanoseconds(segmentEnd).toZonedDateTimeISO(
          timeZone,
        );
    }
    pieces.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    const merged: Array<{ start: bigint; end: bigint }> = [];
    for (const piece of pieces) {
      const previous = merged.at(-1);
      if (previous && piece.start <= previous.end)
        previous.end = piece.end > previous.end ? piece.end : previous.end;
      else merged.push({ ...piece });
    }
    return merged.map((piece) => ({
      start: Temporal.Instant.fromEpochNanoseconds(piece.start).toString({
        smallestUnit: "millisecond",
      }),
      end: Temporal.Instant.fromEpochNanoseconds(piece.end).toString({
        smallestUnit: "millisecond",
      }),
    }));
  } catch (error) {
    if (error instanceof RangeError) throw new HttpError("INVALID_INPUT");
    throw error;
  }
}
