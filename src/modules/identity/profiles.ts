import type { Pool } from "pg";
import { command } from "../../database/command.ts";
import { accountLabels } from "./account-labels.ts";
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
      const labels = await accountLabels(
        client,
        page.flatMap((row) => [
          row.account_id,
          ...("invited_by" in row && typeof row.invited_by === "string"
            ? [row.invited_by]
            : []),
        ]),
      );
      return {
        items: page.map((row) => ({
          accountId: row.account_id,
          accountLabel: labels.get(row.account_id) ?? null,
          createdAt: row.created_at.toISOString(),
        })),
        nextCursor:
          result.rows.length > 20 ? (page.at(-1)?.account_id ?? null) : null,
      };
    },
  );
}
