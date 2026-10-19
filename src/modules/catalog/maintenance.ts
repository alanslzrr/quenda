import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { command } from "../../database/command.ts";
import { HttpError } from "../../http/errors.ts";
import {
  type AuthenticatedAccount,
  requirePermission,
} from "../identity/index.ts";

export async function inspectCatalogResource(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  kind: "facility" | "unit",
  id: string,
) {
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
      const result =
        kind === "facility"
          ? await client.query<{
              id: string;
              name: string;
              withdrawn_at: Date | null;
            }>(
              "SELECT id,name,withdrawn_at FROM domain.facility WHERE tenant_id=$1 AND id=$2",
              [tenantId, id],
            )
          : await client.query<{
              id: string;
              name: string;
              withdrawn_at: Date | null;
              facility_id: string;
            }>(
              "SELECT id,name,withdrawn_at,facility_id FROM domain.reservable_unit WHERE tenant_id=$1 AND id=$2",
              [tenantId, id],
            );
      const row = result.rows[0];
      if (!row) throw new HttpError("NOT_FOUND");
      return {
        tenantId,
        id: row.id,
        name: row.name,
        withdrawnAt: row.withdrawn_at?.toISOString() ?? null,
      };
    },
  );
}

export async function renameCatalogResource(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  kind: "facility" | "unit",
  id: string,
  name: string,
) {
  const normalized = name.trim();
  if (!normalized || normalized.length > 200)
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
      const result =
        kind === "facility"
          ? await client.query<{
              id: string;
              name: string;
              facility_id: string;
            }>(
              "SELECT id,name,id AS facility_id FROM domain.facility WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
              [tenantId, id],
            )
          : await client.query<{
              id: string;
              name: string;
              facility_id: string;
            }>(
              "SELECT id,name,facility_id FROM domain.reservable_unit WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
              [tenantId, id],
            );
      const previous = result.rows[0];
      if (!previous) throw new HttpError("NOT_FOUND");
      await client.query(
        kind === "facility"
          ? "UPDATE domain.facility SET name=$3 WHERE tenant_id=$1 AND id=$2"
          : "UPDATE domain.reservable_unit SET name=$3 WHERE tenant_id=$1 AND id=$2",
        [tenantId, id, normalized],
      );
      await client.query(
        "INSERT INTO domain.catalog_event(tenant_id,id,actor_id,facility_id,unit_id,operation,previous_name,new_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          tenantId,
          randomUUID(),
          actor.accountId,
          previous.facility_id,
          kind === "unit" ? id : null,
          kind === "unit" ? "RENAME_UNIT" : "RENAME_FACILITY",
          previous.name,
          normalized,
        ],
      );
      return { tenantId, id, name: normalized };
    },
  );
}
