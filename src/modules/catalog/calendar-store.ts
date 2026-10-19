import { Temporal } from "@js-temporal/polyfill";
import { DatabaseError, type Pool, type QueryResult } from "pg";
import { command } from "../../database/command.ts";
import { HttpError } from "../../http/errors.ts";
import {
  type AuthenticatedAccount,
  requirePermission,
} from "../identity/index.ts";
import { type UnitCalendarInput, validateUnitCalendar } from "./calendar.ts";
import { openingCoverage } from "./coverage.ts";

interface VersionRow {
  version: number;
  minimum_minutes: number;
  maximum_minutes: number;
  step_minutes: number;
  advance_days: number | null;
  weekly: UnitCalendarInput["weekly"];
  exceptions: UnitCalendarInput["exceptions"];
  actor_id: string;
  reason: string;
  created_at: Date;
}
function output(tenantId: string, unitId: string, row: VersionRow) {
  return {
    tenantId,
    unitId,
    version: row.version,
    actorId: row.actor_id,
    reason: row.reason,
    createdAt: row.created_at.toISOString(),
    calendar: {
      minimumMinutes: row.minimum_minutes,
      maximumMinutes: row.maximum_minutes,
      stepMinutes: row.step_minutes,
      advanceDays: row.advance_days,
      weekly: row.weekly,
      exceptions: row.exceptions,
    },
  };
}
export async function saveUnitCalendar(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  unitId: string,
  input: {
    expectedVersion: number;
    reason: string;
    calendar: UnitCalendarInput;
  },
) {
  if (
    !Number.isInteger(input.expectedVersion) ||
    input.expectedVersion < 0 ||
    input.expectedVersion >= 2147483647 ||
    !input.reason.trim() ||
    input.reason.trim().length > 500
  )
    throw new HttpError("INVALID_INPUT");
  return command(
    pool,
    { accountId: actor.accountId, tenantId },
    async (client) => {
      await requirePermission(client, actor, "CATALOG_MANAGE", unitId);
      const unit = await client.query<{ calendar_version: number | null }>(
        "SELECT id,calendar_version FROM domain.reservable_unit WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [tenantId, unitId],
      );
      if (!unit.rowCount) throw new HttpError("NOT_FOUND");
      const municipality = await client.query<{
        advance_days: number;
        timezone: string;
      }>("SELECT advance_days,timezone FROM domain.municipality WHERE id=$1", [
        tenantId,
      ]);
      const limits = municipality.rows[0];
      if (!limits) throw new HttpError("NOT_FOUND");
      const calendar = validateUnitCalendar(
        input.calendar,
        limits.advance_days,
      );
      const version = unit.rows[0]?.calendar_version ?? 0;
      if (version !== input.expectedVersion) throw new HttpError("CONFLICT");
      // Existing bookings retain their accepted duration/advance policy. A new
      // opening must still cover their complete interval, including ongoing use.
      const covered = openingCoverage(calendar, limits.timezone);
      let afterStart: string | null = null;
      for (;;) {
        const intervals: QueryResult<{ starts_at: Date; ends_at: Date }> =
          await client.query<{
            starts_at: Date;
            ends_at: Date;
          }>("SELECT * FROM domain.calendar_reservation_intervals($1,$2)", [
            unitId,
            afterStart,
          ]);
        for (const interval of intervals.rows) {
          if (
            !covered(
              Temporal.Instant.from(interval.starts_at.toISOString()),
              Temporal.Instant.from(interval.ends_at.toISOString()),
            )
          )
            throw new HttpError("CONFLICT");
        }
        if (intervals.rows.length < 100) break;
        afterStart = intervals.rows.at(-1)?.starts_at.toISOString() ?? null;
      }
      const saved = await client.query<VersionRow>(
        `INSERT INTO domain.unit_calendar_version(tenant_id,unit_id,version,minimum_minutes,maximum_minutes,step_minutes,advance_days,weekly,exceptions,actor_id,reason)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [
          tenantId,
          unitId,
          version + 1,
          calendar.minimumMinutes,
          calendar.maximumMinutes,
          calendar.stepMinutes,
          calendar.advanceDays,
          JSON.stringify(calendar.weekly),
          JSON.stringify(calendar.exceptions),
          actor.accountId,
          input.reason.trim(),
        ],
      );
      const row = saved.rows[0];
      if (!row) throw new Error("Missing saved calendar version");
      await client.query(
        "UPDATE domain.reservable_unit SET calendar_version=$3 WHERE tenant_id=$1 AND id=$2",
        [tenantId, unitId, version + 1],
      );
      return output(tenantId, unitId, row);
    },
  ).catch((error: unknown) => {
    if (
      error instanceof DatabaseError &&
      ["40001", "40P01"].includes(error.code ?? "")
    )
      throw new HttpError("CONFLICT");
    throw error;
  });
}
export async function readUnitCalendar(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  unitId: string,
  version: number | null = null,
) {
  if (
    version !== null &&
    (!Number.isInteger(version) || version < 1 || version > 2147483647)
  )
    throw new HttpError("INVALID_INPUT");
  return command(
    pool,
    { accountId: actor.accountId, tenantId },
    async (client) => {
      await requirePermission(client, actor, "CATALOG_MANAGE", unitId);
      const result = await client.query<VersionRow>(
        "SELECT v.* FROM domain.unit_calendar_version v JOIN domain.reservable_unit u ON (u.tenant_id,u.id)=(v.tenant_id,v.unit_id) WHERE v.tenant_id=$1 AND v.unit_id=$2 AND v.version=coalesce($3::integer,u.calendar_version)",
        [tenantId, unitId, version],
      );
      const row = result.rows[0];
      if (!row) throw new HttpError("NOT_FOUND");
      return output(tenantId, unitId, row);
    },
  );
}
