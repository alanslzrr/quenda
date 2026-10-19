import type { Pool } from "pg";
import { command } from "../../database/command.ts";
import {
  type AuthenticatedAccount,
  requireRecentMfa,
} from "../identity/index.ts";

export async function listCatalogResources(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  kind: "facility" | "unit",
  after: string | null = null,
) {
  requireRecentMfa(actor);
  return command(
    pool,
    { accountId: actor.accountId, tenantId },
    async (client) => {
      // RLS filters before ordering/limiting. A unit-scoped manager does not need
      // municipality-wide authority to discover their own accessible units.
      const result = await client.query<{
        id: string;
        name: string;
        facility_id: string;
        withdrawn_at: Date | null;
      }>(
        kind === "facility"
          ? "SELECT id,name,withdrawn_at,id AS facility_id FROM domain.facility WHERE tenant_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 21"
          : "SELECT id,name,withdrawn_at,facility_id FROM domain.reservable_unit WHERE tenant_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 21",
        [tenantId, after],
      );
      const page = result.rows.slice(0, 20);
      return {
        items: page.map((row) => ({
          id: row.id,
          name: row.name,
          facilityId: row.facility_id,
          withdrawnAt: row.withdrawn_at?.toISOString() ?? null,
        })),
        nextCursor: result.rows.length > 20 ? (page.at(-1)?.id ?? null) : null,
      };
    },
  );
}
