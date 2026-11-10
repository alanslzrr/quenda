import { Temporal } from "@js-temporal/polyfill";
import type { PoolClient } from "pg";
import { HttpError } from "../../http/errors.ts";
import { publicUnitCalendar } from "./public.ts";
import { calendarSlots } from "./slots.ts";

export async function validateReservableInterval(
  client: PoolClient,
  tenantId: string,
  unitId: string,
  startsAt: string,
  endsAt: string,
  now: string,
) {
  const unit = await publicUnitCalendar(client, tenantId, unitId);
  const start = Temporal.Instant.from(startsAt),
    end = Temporal.Instant.from(endsAt);
  const durationMinutes =
    Number(end.epochNanoseconds - start.epochNanoseconds) / 60_000_000_000;
  const date = start.toZonedDateTimeISO(unit.timeZone).toPlainDate().toString();
  const slots = calendarSlots({
    calendar: unit.calendar,
    date,
    timeZone: unit.timeZone,
    durationMinutes,
    municipalAdvanceDays: unit.municipalAdvanceDays,
    now,
  });
  if (
    !slots.some(
      (slot) => slot.start.utc === startsAt && slot.end.utc === endsAt,
    )
  )
    throw new HttpError("BOOKING_RULES_CHANGED");
  return {
    calendarVersion: unit.calendarVersion,
    cancellationMinutes: unit.cancellationMinutes,
    timeZone: unit.timeZone,
  };
}
