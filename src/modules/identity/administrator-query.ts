import type { Pool } from "pg";
import { command } from "../../database/command.ts";
import { accountLabels } from "./account-labels.ts";
import { requireAdministrator } from "./administrator.ts";
import type { AuthenticatedAccount } from "./auth.ts";

export async function listMunicipalAdministrators(
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
        invitation_id: string;
        granted_at: Date;
        expires_at: Date | null;
        revoked_at: Date | null;
        active: boolean;
      }>(
        `SELECT account_id,invitation_id,granted_at,expires_at,revoked_at,
         domain.municipal_administrator_is_enabled(account_id) AS active
       FROM domain.municipal_administrator WHERE tenant_id=$1 AND ($2::text IS NULL OR account_id>$2)
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
          invitationId: row.invitation_id,
          grantedAt: row.granted_at.toISOString(),
          expiresAt: row.expires_at?.toISOString() ?? null,
          revokedAt: row.revoked_at?.toISOString() ?? null,
          active: row.active,
        })),
        nextCursor:
          result.rows.length > 20 ? (page.at(-1)?.account_id ?? null) : null,
      };
    },
  );
}

export async function listMunicipalAdministratorInvitations(
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
        id: string;
        account_id: string;
        invited_by: string;
        expires_at: Date;
        role_expires_at: Date | null;
        accepted_at: Date | null;
        revoked_at: Date | null;
      }>(
        `SELECT id,account_id,invited_by,expires_at,role_expires_at,accepted_at,revoked_at
       FROM domain.administrator_invitation WHERE tenant_id=$1 AND ($2::uuid IS NULL OR id>$2)
       ORDER BY id LIMIT 21`,
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
          invitationId: row.id,
          accountId: row.account_id,
          accountLabel: labels.get(row.account_id) ?? null,
          invitedBy: row.invited_by,
          invitedByLabel: labels.get(row.invited_by) ?? null,
          expiresAt: row.expires_at.toISOString(),
          roleExpiresAt: row.role_expires_at?.toISOString() ?? null,
          acceptedAt: row.accepted_at?.toISOString() ?? null,
          revokedAt: row.revoked_at?.toISOString() ?? null,
        })),
        nextCursor: result.rows.length > 20 ? (page.at(-1)?.id ?? null) : null,
      };
    },
  );
}
