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
  const result = await pool.query<{ id: string; name: string; units: number }>(
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
    minimum_minutes: number;
    maximum_minutes: number;
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
      minimumMinutes: row.minimum_minutes,
      maximumMinutes: row.maximum_minutes,
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
    facility_name: string;
  }>("SELECT * FROM domain.public_unit_calendar($1,$2)", [tenantId, unitId]);
  const row = result.rows[0];
  if (!row) throw new HttpError("NOT_FOUND");
  return {
    id: row.id,
    name: row.name,
    facilityId: row.facility_id,
    facilityName: row.facility_name,
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
    const candidate = await candidateAvailability(
      client,
      tenantId,
      unitId,
      date,
      durationMinutes,
      clock,
    );
    const candidates = candidate.slots;
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
      ...candidate,
      slots: candidates.filter((_, index) => positions.has(index + 1)),
    };
  });
}

// Calendar rules are shared by public browsing and authorized rescheduling.
export async function candidateAvailability(
  client: Pool | PoolClient,
  tenantId: string,
  unitId: string,
  date: string,
  durationMinutes: number,
  clock: Clock = systemClock,
) {
  const unit = await publicUnitCalendar(client, tenantId, unitId);
  const now = clock.now().toISOString();
  return {
    unitId,
    date,
    timeZone: unit.timeZone,
    calendarVersion: unit.calendarVersion,
    calculatedAt: now,
    slots: calendarSlots({
      calendar: unit.calendar,
      date,
      durationMinutes,
      timeZone: unit.timeZone,
      municipalAdvanceDays: unit.municipalAdvanceDays,
      now,
    }),
  };
}

/** Bounded catalog scan: a page can be empty while nextCursor continues the search. */
export async function publicAvailabilitySearch(
  pool: Pool,
  tenantId: string,
  date: string,
  durationMinutes: number,
  after: string | null = null,
  clock: Clock = systemClock,
  facilityId: string | null = null,
) {
  return transaction(pool, async (client) => {
    const rows = (
      await client.query<{ id: string; name: string; facility_name: string }>(
        "SELECT * FROM domain.public_search_units($1,$2)",
        [tenantId, after],
      )
    ).rows;
    const items = [];
    for (const row of rows.slice(0, 20)) {
      const unit = await publicUnitCalendar(client, tenantId, row.id);
      if (
        (facilityId && unit.facilityId !== facilityId) ||
        durationMinutes < unit.calendar.minimumMinutes ||
        durationMinutes > unit.calendar.maximumMinutes ||
        durationMinutes % unit.calendar.stepMinutes !== 0
      )
        continue;
      const candidate = await candidateAvailability(
        client,
        tenantId,
        row.id,
        date,
        durationMinutes,
        clock,
      );
      const available = await client.query<{ slot_index: number }>(
        "SELECT slot_index FROM domain.public_available_slots($1,$2,$3::timestamptz[],$4::timestamptz[])",
        [
          tenantId,
          row.id,
          candidate.slots.map((s) => s.start.utc),
          candidate.slots.map((s) => s.end.utc),
        ],
      );
      const positions = new Set(available.rows.map((r) => r.slot_index));
      const slots = candidate.slots.filter((_, index) =>
        positions.has(index + 1),
      );
      if (slots.length)
        items.push({
          id: row.id,
          name: row.name,
          facilityId: unit.facilityId,
          facilityName: row.facility_name,
          ...candidate,
          slots,
        });
    }
    return {
      items,
      nextCursor: rows.length > 20 ? (rows[19]?.id ?? null) : null,
    };
  });
}
export async function publicBookingDurations(pool: Pool, tenantId: string) {
  const result = await pool.query<{
    minutes: number;
    units: number;
    has_more: boolean;
  }>("SELECT * FROM domain.public_booking_durations($1)", [tenantId]);
  // Rows are ordered by duration, so ties keep the shortest duration.
  const recommended = result.rows.reduce<(typeof result.rows)[number] | null>(
    (best, row) => (!best || row.units > best.units ? row : best),
    null,
  );
  return {
    durations: result.rows.map((row) => row.minutes),
    hasMore: result.rows.some((row) => row.has_more),
    ...(recommended ? { recommended: recommended.minutes } : {}),
  };
}
