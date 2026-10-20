import type { Pool, PoolClient } from "pg";
import { transaction } from "../../database/transaction.ts";
import { HttpError } from "../../http/errors.ts";
import { type Clock, systemClock } from "../../shared/clock.ts";
import type { UnitCalendarInput } from "./calendar.ts";
import { calendarSlots } from "./slots.ts";

export async function publicFacilities(
  pool: Pool,
  tenantId: string,
  after: string | null = null,
) {
  const result = await pool.query<{ id: string; name: string }>(
    "SELECT * FROM domain.public_facilities($1,$2)",
    [tenantId, after],
  );
  return {
    items: result.rows.slice(0, 20),
    nextCursor: result.rows.length > 20 ? (result.rows[19]?.id ?? null) : null,
  };
}
export async function publicUnits(
  pool: Pool,
  tenantId: string,
  facilityId: string,
  after: string | null = null,
) {
  const result = await pool.query<{
    id: string;
    name: string;
    facility_id: string;
  }>("SELECT * FROM domain.public_units($1,$2,$3)", [
    tenantId,
    facilityId,
    after,
  ]);
  return {
    items: result.rows.slice(0, 20).map((row) => ({
      id: row.id,
      name: row.name,
      facilityId: row.facility_id,
    })),
    nextCursor: result.rows.length > 20 ? (result.rows[19]?.id ?? null) : null,
  };
}
export async function publicUnitCalendar(
  pool: Pool | PoolClient,
  tenantId: string,
  unitId: string,
) {
  const result = await pool.query<{
    id: string;
    name: string;
    facility_id: string;
    timezone: string;
    municipal_advance_days: number;
    cancellation_minutes: number;
    booking_policy_version: number;
    usage_rules_version: number;
    version: number;
    calendar: UnitCalendarInput;
  }>("SELECT * FROM domain.public_unit_calendar($1,$2)", [tenantId, unitId]);
  const row = result.rows[0];
  if (!row) throw new HttpError("NOT_FOUND");
  return {
    id: row.id,
    name: row.name,
    facilityId: row.facility_id,
    timeZone: row.timezone,
    municipalAdvanceDays: row.municipal_advance_days,
    cancellationMinutes: row.cancellation_minutes,
    bookingPolicyVersion: row.booking_policy_version,
    usageRulesVersion: row.usage_rules_version,
    calendarVersion: row.version,
    calendar: row.calendar,
  };
}
export async function publicAvailability(
  pool: Pool,
  tenantId: string,
  unitId: string,
  date: string,
  durationMinutes: number,
  clock: Clock = systemClock,
) {
  return transaction(pool, async (client) => {
    const unit = await publicUnitCalendar(client, tenantId, unitId);
    const now = clock.now().toISOString();
    const candidates = calendarSlots({
      calendar: unit.calendar,
      date,
      durationMinutes,
      timeZone: unit.timeZone,
      municipalAdvanceDays: unit.municipalAdvanceDays,
      now,
    });
    const available = await client.query<{ slot_index: number }>(
      "SELECT slot_index FROM domain.public_available_slots($1,$2,$3::timestamptz[],$4::timestamptz[])",
      [
        tenantId,
        unitId,
        candidates.map((slot) => slot.start.utc),
        candidates.map((slot) => slot.end.utc),
      ],
    );
    const positions = new Set(available.rows.map((row) => row.slot_index));
    return {
      unitId,
      date,
      timeZone: unit.timeZone,
      calendarVersion: unit.calendarVersion,
      calculatedAt: now,
      slots: candidates.filter((_, index) => positions.has(index + 1)),
    };
  });
}
