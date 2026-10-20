import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { command } from "../../database/command.ts";
import { HttpError } from "../../http/errors.ts";
import {
  type AuthenticatedAccount,
  requirePermission,
} from "../identity/index.ts";
import { validateUnitCalendar } from "./calendar.ts";

export async function publishCatalogResource(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  kind: "facility" | "unit",
  id: string,
  input: {
    reason: string;
    calendarVersion?: number;
    independenceConfirmed?: boolean;
  },
) {
  const reason = input.reason.trim();
  if (
    !reason ||
    reason.length > 500 ||
    (kind === "unit" &&
      (!Number.isInteger(input.calendarVersion) ||
        !input.calendarVersion ||
        input.calendarVersion < 1 ||
        input.independenceConfirmed !== true))
  )
    throw new HttpError("INVALID_INPUT");
  return command(
    pool,
    { accountId: actor.accountId, tenantId },
    async (client) => {
      await requirePermission(
        client,
        actor,
        "CATALOG_MANAGE",
        kind === "unit" ? id : null,
      );
      if (kind === "unit") {
        const parent = await client.query(
          "SELECT * FROM domain.lock_publication_parent($1)",
          [id],
        );
        if (!parent.rows[0]) throw new HttpError("NOT_FOUND");
        if (!parent.rows[0].published_at || parent.rows[0].withdrawn_at)
          throw new HttpError("CONFLICT");
      }
      const result = await client.query<{
        facility_id: string;
        published_at: Date | null;
        withdrawn_at: Date | null;
        calendar_version: number | null;
      }>(
        kind === "facility"
          ? "SELECT id AS facility_id,published_at,withdrawn_at,NULL::integer AS calendar_version FROM domain.facility WHERE tenant_id=$1 AND id=$2 FOR UPDATE"
          : "SELECT facility_id,published_at,withdrawn_at,calendar_version FROM domain.reservable_unit WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [tenantId, id],
      );
      const resource = result.rows[0];
      if (!resource) throw new HttpError("NOT_FOUND");
      if (kind === "unit") {
        const rules = await client.query(
          `SELECT 1 FROM domain.unit_usage_rules v JOIN domain.reservable_unit u
           ON (u.tenant_id,u.id,u.usage_rules_version)=(v.tenant_id,v.unit_id,v.version)
           WHERE u.tenant_id=$1 AND u.id=$2 AND v.text_content ~ '[^[:space:]]'`,
          [tenantId, id],
        );
        if (!rules.rowCount) throw new HttpError("USAGE_RULES_REQUIRED");
        if (resource.calendar_version !== input.calendarVersion)
          throw new HttpError("CONFLICT");
        const configuration = await client.query(
          `SELECT v.*,m.advance_days AS municipal_advance_days FROM domain.unit_calendar_version v JOIN domain.municipality m ON m.id=v.tenant_id WHERE v.tenant_id=$1 AND v.unit_id=$2 AND v.version=$3`,
          [tenantId, id, resource.calendar_version],
        );
        const row = configuration.rows[0];
        if (!row) throw new HttpError("CONFLICT");
        validateUnitCalendar(
          {
            minimumMinutes: row.minimum_minutes,
            maximumMinutes: row.maximum_minutes,
            stepMinutes: row.step_minutes,
            advanceDays: row.advance_days,
            weekly: row.weekly,
            exceptions: row.exceptions,
          },
          row.municipal_advance_days,
        );
      }
      if (resource.published_at && !resource.withdrawn_at)
        return {
          tenantId,
          id,
          publishedAt: resource.published_at.toISOString(),
        };
      const changed = await client.query<{ published_at: Date }>(
        kind === "facility"
          ? "UPDATE domain.facility SET published_at=now(),withdrawn_at=NULL WHERE tenant_id=$1 AND id=$2 RETURNING published_at"
          : "UPDATE domain.reservable_unit SET published_at=now(),withdrawn_at=NULL WHERE tenant_id=$1 AND id=$2 RETURNING published_at",
        [tenantId, id],
      );
      await client.query(
        "INSERT INTO domain.catalog_event(tenant_id,id,actor_id,facility_id,unit_id,operation,reason,calendar_version,independence_confirmed) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [
          tenantId,
          randomUUID(),
          actor.accountId,
          resource.facility_id,
          kind === "unit" ? id : null,
          kind === "unit" ? "PUBLISH_UNIT" : "PUBLISH_FACILITY",
          reason,
          kind === "unit" ? resource.calendar_version : null,
          kind === "unit" ? true : null,
        ],
      );
      const row = changed.rows[0];
      if (!row) throw new Error("Missing publication result");
      return { tenantId, id, publishedAt: row.published_at.toISOString() };
    },
  );
}
