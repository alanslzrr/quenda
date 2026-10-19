import { Temporal } from "@js-temporal/polyfill";
import { HttpError } from "../../http/errors.ts";
import { localDate } from "./calendar.ts";

function input<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof RangeError) throw new HttpError("INVALID_INPUT");
    throw error;
  }
}
function namedZone(zone: string) {
  // Temporal also accepts fixed-offset identifiers; municipality configuration
  // requires a named IANA zone (UTC included), not a frozen UTC offset.
  if (!zone || /^[+-]/.test(zone)) throw new HttpError("INVALID_INPUT");
  new Intl.DateTimeFormat("en", { timeZone: zone });
}

export interface ZonedInstant {
  utc: string;
  local: string;
  offset: string;
  timeZone: string;
}
function describe(value: Temporal.ZonedDateTime): ZonedInstant {
  return {
    utc: value.toInstant().toString({ smallestUnit: "millisecond" }),
    local: value.toPlainDateTime().toString({ smallestUnit: "minute" }),
    offset: value.offset,
    timeZone: value.timeZoneId,
  };
}

export function possibleLocalInstants(
  date: string,
  minute: number,
  timeZone: string,
): ZonedInstant[] {
  localDate(date);
  if (!Number.isInteger(minute) || minute < 0 || minute > 1440)
    throw new HttpError("INVALID_INPUT");
  return input(() => {
    namedZone(timeZone);
    const wall = Temporal.PlainDate.from(date)
      .toPlainDateTime("00:00")
      .add({ minutes: minute });
    const candidates = ["earlier", "later"].map((disambiguation) =>
      wall.toZonedDateTime(timeZone, {
        disambiguation: disambiguation as "earlier" | "later",
      }),
    );
    const unique = new Map<string, Temporal.ZonedDateTime>();
    for (const candidate of candidates) {
      // Both modes shift nonexistent times. Round-trip equality is essential:
      // never silently offer a shifted time for a DST gap or a skipped date.
      if (candidate.toPlainDateTime().equals(wall))
        unique.set(candidate.epochNanoseconds.toString(), candidate);
    }
    return [...unique.values()]
      .sort(Temporal.ZonedDateTime.compare)
      .map(describe);
  });
}

export function describeInstant(utc: string, timeZone: string): ZonedInstant {
  return input(() => {
    namedZone(timeZone);
    return describe(Temporal.Instant.from(utc).toZonedDateTimeISO(timeZone));
  });
}

export function withinAdvanceWindow(
  startUtc: string,
  nowUtc: string,
  timeZone: string,
  municipalDays: number,
  unitDays: number | null,
): boolean {
  if (
    !Number.isSafeInteger(municipalDays) ||
    municipalDays < 0 ||
    municipalDays > 2147483647 ||
    (unitDays !== null &&
      (!Number.isSafeInteger(unitDays) ||
        unitDays < 0 ||
        unitDays > municipalDays))
  )
    throw new HttpError("INVALID_INPUT");
  return input(() => {
    namedZone(timeZone);
    const start = Temporal.Instant.from(startUtc);
    const now = Temporal.Instant.from(nowUtc);
    if (Temporal.Instant.compare(start, now) <= 0) return false;
    const startDay = start.toZonedDateTimeISO(timeZone).toPlainDate();
    const today = now.toZonedDateTimeISO(timeZone).toPlainDate();
    const days = startDay.since(today, { largestUnit: "day" }).days;
    return days >= 0 && days <= (unitDays ?? municipalDays);
  });
}
