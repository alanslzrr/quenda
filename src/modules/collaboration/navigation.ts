import type { Pool } from "pg";
import { command } from "../../database/command.ts";
import {
  type AuthenticatedAccount,
  accountLabels,
  requireAdministrator,
} from "../identity/index.ts";

export async function issuedCredentials(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  after: string | null,
) {
  return command(
    pool,
    { accountId: actor.accountId, tenantId },
    async (client) => {
      await requireAdministrator(client, actor);
      const result = await client.query<{
        id: string;
        agreement_id: string;
        agreement_name: string;
        account_id: string;
        starts_at: Date;
        ends_at: Date;
        revoked_at: Date | null;
      }>("SELECT * FROM domain.issued_credentials($1::uuid)", [after]);
      const page = result.rows.slice(0, 20);
      const labels = await accountLabels(
        client,
        page.map((row) => row.account_id),
      );
      return {
        items: page.map((row) => ({
          id: row.id,
          agreementId: row.agreement_id,
          agreementName: row.agreement_name,
          accountId: row.account_id,
          accountLabel: labels.get(row.account_id) ?? null,
          startsAt: row.starts_at.toISOString(),
          endsAt: row.ends_at.toISOString(),
          revokedAt: row.revoked_at?.toISOString() ?? null,
        })),
        nextCursor: result.rows.length > 20 ? (page.at(-1)?.id ?? null) : null,
      };
    },
  );
}
export async function monthlyReviewOptions(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  agreementId: string,
  after: string | null,
) {
  return command(
    pool,
    { accountId: actor.accountId, tenantId },
    async (client) => {
      await requireAdministrator(client, actor);
      const result = await client.query<{
        month: string;
        revision: number;
        participants: { id: string; name: string }[];
      }>("SELECT * FROM domain.monthly_review_options($1::uuid,$2::date)", [
        agreementId,
        after ? `${after}-01` : null,
      ]);
      const items = result.rows.slice(0, 20);
      return {
        items,
        nextCursor:
          result.rows.length > 20 ? (items.at(-1)?.month ?? null) : null,
      };
    },
  );
}
