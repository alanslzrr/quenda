import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { command } from "../../database/command.ts";
import { HttpError } from "../../http/errors.ts";
import {
  type AuthenticatedAccount,
  requirePermission,
} from "../identity/index.ts";

export async function withdrawCatalogResource(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  kind: "facility" | "unit",
  id: string,
  reason: string,
) {
  const rationale = reason.trim();
  if (!rationale || rationale.length > 500)
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
      const result = await client.query<{
        facility_id: string;
        withdrawn_at: Date | null;
      }>(
        kind === "facility"
          ? "SELECT id AS facility_id,withdrawn_at FROM domain.facility WHERE tenant_id=$1 AND id=$2 FOR UPDATE"
          : "SELECT facility_id,withdrawn_at FROM domain.reservable_unit WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [tenantId, id],
      );
      const resource = result.rows[0];
      if (!resource) throw new HttpError("NOT_FOUND");
      if (resource.withdrawn_at)
        return {
          tenantId,
          id,
          withdrawnAt: resource.withdrawn_at.toISOString(),
        };
      const updated = await client.query<{ withdrawn_at: Date }>(
        kind === "facility"
          ? "UPDATE domain.facility SET withdrawn_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING withdrawn_at"
          : "UPDATE domain.reservable_unit SET withdrawn_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING withdrawn_at",
        [tenantId, id],
      );
      await client.query(
        "INSERT INTO domain.catalog_event(tenant_id,id,actor_id,facility_id,unit_id,operation,reason) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [
          tenantId,
          randomUUID(),
          actor.accountId,
          resource.facility_id,
          kind === "unit" ? id : null,
          kind === "unit" ? "WITHDRAW_UNIT" : "WITHDRAW_FACILITY",
          rationale,
        ],
      );
      return {
        tenantId,
        id,
        withdrawnAt: updated.rows[0]?.withdrawn_at.toISOString(),
      };
    },
  );
}
