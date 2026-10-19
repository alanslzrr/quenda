import { Temporal } from "@js-temporal/polyfill";
import { HttpError } from "../../http/errors.ts";

// Quota attribution uses the reservation start, not creation time or UTC weeks.
// The agreement's IANA zone is stable across its versions.
export function weeklyQuotaPeriod(startsAt: string, timeZone: string) {
  try {
    if (!timeZone || /^[+-]/.test(timeZone))
      throw new HttpError("INVALID_INPUT");
    new Intl.DateTimeFormat("en", { timeZone });
    const day = Temporal.Instant.from(startsAt)
      .toZonedDateTimeISO(timeZone)
      .toPlainDate();
    const monday = day.subtract({ days: day.dayOfWeek - 1 });
    return {
      weekStart: monday.toString(),
      startsAt: monday
        .toZonedDateTime(timeZone)
        .toInstant()
        .toString({ smallestUnit: "millisecond" }),
      endsAt: monday
        .add({ days: 7 })
        .toZonedDateTime(timeZone)
        .toInstant()
        .toString({ smallestUnit: "millisecond" }),
    };
  } catch (error) {
    if (error instanceof RangeError) throw new HttpError("INVALID_INPUT");
    throw error;
  }
}
