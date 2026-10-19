import type { Pool } from "pg";
import { command } from "../../database/command.ts";
import { requireAdministrator } from "./administrator.ts";
import type { AuthenticatedAccount } from "./auth.ts";

export async function listMunicipalProfiles(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  after: string | null = null,
) {
  return command(
    pool,
    { accountId: actor.accountId, tenantId },
    async (client) => {
      await requireAdministrator(client, actor);
      const result = await client.query<{
        account_id: string;
        created_at: Date;
      }>(
        `SELECT account_id,created_at FROM domain.municipal_profile
       WHERE tenant_id=$1 AND ($2::text IS NULL OR account_id>$2)
       ORDER BY account_id LIMIT 21`,
        [tenantId, after],
      );
      const page = result.rows.slice(0, 20);
      return {
        items: page.map((row) => ({
          accountId: row.account_id,
          createdAt: row.created_at.toISOString(),
        })),
        nextCursor:
          result.rows.length > 20 ? (page.at(-1)?.account_id ?? null) : null,
      };
    },
  );
}
