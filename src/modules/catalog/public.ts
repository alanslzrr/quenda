import { Temporal } from "@js-temporal/polyfill";
import type { Pool, PoolClient } from "pg";
import { command } from "../../database/command.ts";
import { HttpError } from "../../http/errors.ts";
import { type Clock, systemClock } from "../../shared/clock.ts";
import type { UnitCalendarInput } from "./calendar.ts";
import { publicPhotos } from "./photos.ts";
import { type CalendarSlot, calendarSlots } from "./slots.ts";

export async function publicFacilities(
  pool: Pool,
  tenantId: string,
  after: string | null = null,
) {
  const result = await pool.query<{
    id: string;
    name: string;
    units: number;
    profile: unknown;
  }>("SELECT * FROM domain.public_facilities($1,$2)", [tenantId, after]);
  const items = result.rows.slice(0, 20);
  const photos = await publicPhotos(
    pool,
    tenantId,
    items.map((row) => row.id),
  );
  return {
    items: items.map((row) => ({ ...row, photos: photos.get(row.id) ?? [] })),
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
    profile: unknown;
  }>("SELECT * FROM domain.public_units($1,$2,$3)", [
    tenantId,
    facilityId,
    after,
  ]);
  const items = result.rows.slice(0, 20);
  const photos = await publicPhotos(
    pool,
    tenantId,
    items.map((row) => row.id),
  );
  return {
    items: items.map((row) => ({
      id: row.id,
      name: row.name,
      facilityId: row.facility_id,
      minimumMinutes: row.minimum_minutes,
      maximumMinutes: row.maximum_minutes,
      profile: row.profile,
      photos: photos.get(row.id) ?? [],
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
    profile: unknown;
    facility_profile: unknown;
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
    profile: row.profile,
    facilityProfile: row.facility_profile,
  };
}
/**
 * The public page of a unit: its calendar plus the photos of the unit and of
 * its facility. Booking and availability checks read the calendar alone.
 */
export async function publicUnitDetail(
  pool: Pool,
  tenantId: string,
  unitId: string,
) {
  const unit = await publicUnitCalendar(pool, tenantId, unitId);
  const photos = await publicPhotos(pool, tenantId, [unit.id, unit.facilityId]);
  return {
    ...unit,
    photos: photos.get(unit.id) ?? [],
    facilityPhotos: photos.get(unit.facilityId) ?? [],
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
  return command(pool, undefined, async (client) => {
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

/** Days ahead that a suggestion looks at; the unit's advance limit usually ends it earlier. */
const suggestionHorizonDays = 62;

/**
 * The first free slots of a duration from a date onwards: what to offer when the
 * chosen day is full. All candidate days are checked against occupancy in one
 * query, inside the same transaction as the calendar.
 */
export async function nextPublicAvailability(
  pool: Pool,
  tenantId: string,
  unitId: string,
  from: string,
  durationMinutes: number,
  limit = 3,
  clock: Clock = systemClock,
) {
  return command(pool, undefined, async (client) => {
    const unit = await publicUnitCalendar(client, tenantId, unitId);
    const first = availabilityFromCalendar(unit, from, durationMinutes, clock);
    const candidates = [...first.slots];
    let date = Temporal.PlainDate.from(from);
    for (let day = 1; day < suggestionHorizonDays; day++) {
      date = date.add({ days: 1 });
      candidates.push(
        ...availabilityFromCalendar(
          unit,
          date.toString(),
          durationMinutes,
          clock,
        ).slots,
      );
    }
    const available = candidates.length
      ? await client.query<{ slot_index: number }>(
          "SELECT slot_index FROM domain.public_available_slots($1,$2,$3::timestamptz[],$4::timestamptz[])",
          [
            tenantId,
            unitId,
            candidates.map((slot) => slot.start.utc),
            candidates.map((slot) => slot.end.utc),
          ],
        )
      : { rows: [] };
    const positions = new Set(available.rows.map((row) => row.slot_index));
    return {
      unitId: first.unitId,
      from,
      timeZone: first.timeZone,
      calendarVersion: first.calendarVersion,
      calculatedAt: first.calculatedAt,
      slots: candidates
        .filter((_, index) => positions.has(index + 1))
        .slice(0, limit),
    };
  });
}

const minuteOfDay = (local: string) =>
  Number(local.slice(11, 13)) * 60 + Number(local.slice(14, 16));

/**
 * The first free slot, from today onwards, that repeats a habit: the same ISO
 * weekday, local start minute and duration. Only matching days within the
 * suggestion horizon are tried, and their occupancy is checked in one query.
 * Throws like the public availability when the unit is not public or the
 * duration is not admitted; returns null when no matching slot is free.
 */
export async function nextHabitualSlot(
  client: PoolClient,
  tenantId: string,
  unitId: string,
  habit: { weekday: number; startMinute: number; durationMinutes: number },
  clock: Clock = systemClock,
) {
  const unit = await publicUnitCalendar(client, tenantId, unitId);
  let date = Temporal.Instant.from(clock.now().toISOString())
    .toZonedDateTimeISO(unit.timeZone)
    .toPlainDate();
  const candidates: CalendarSlot[] = [];
  for (let day = 0; day < suggestionHorizonDays; day++) {
    if (date.dayOfWeek === habit.weekday) {
      const slot = availabilityFromCalendar(
        unit,
        date.toString(),
        habit.durationMinutes,
        clock,
      ).slots.find(
        (slot) => minuteOfDay(slot.start.local) === habit.startMinute,
      );
      if (slot) candidates.push(slot);
    }
    date = date.add({ days: 1 });
  }
  if (!candidates.length) return null;
  const available = await client.query<{ slot_index: number }>(
    "SELECT slot_index FROM domain.public_available_slots($1,$2,$3::timestamptz[],$4::timestamptz[]) ORDER BY slot_index LIMIT 1",
    [
      tenantId,
      unitId,
      candidates.map((slot) => slot.start.utc),
      candidates.map((slot) => slot.end.utc),
    ],
  );
  const index = available.rows[0]?.slot_index;
  const slot = index === undefined ? undefined : candidates[index - 1];
  return slot
    ? { unitName: unit.name, facilityName: unit.facilityName, slot }
    : null;
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
  return availabilityFromCalendar(unit, date, durationMinutes, clock);
}
function availabilityFromCalendar(
  unit: Awaited<ReturnType<typeof publicUnitCalendar>>,
  date: string,
  durationMinutes: number,
  clock: Clock,
) {
  const unitId = unit.id;
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
  return command(pool, undefined, async (client) => {
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
      const candidate = availabilityFromCalendar(
        unit,
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
