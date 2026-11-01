import type { Pool } from "pg";
import { command } from "../../database/command.ts";
import { accountLabels } from "./account-labels.ts";
import { requireAdministrator } from "./administrator.ts";
import type { AuthenticatedAccount } from "./auth.ts";
import type { ManagerInvitationInput } from "./manager.ts";

export async function listMunicipalManagerInvitations(
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
        replaces_invitation_id: string | null;
        permissions: ManagerInvitationInput["permissions"];
      }>(
        `SELECT i.id,i.account_id,i.invited_by,i.expires_at,i.role_expires_at,i.accepted_at,
      coalesce(g.revoked_at,i.revoked_at) AS revoked_at,i.replaces_invitation_id,
      (SELECT jsonb_agg(jsonb_build_object('operation',p.operation,'unitId',p.unit_id) ORDER BY p.operation,p.unit_id)
        FROM domain.manager_permission p WHERE p.tenant_id=i.tenant_id AND p.invitation_id=i.id) AS permissions
      FROM domain.manager_invitation i LEFT JOIN domain.manager_grant g ON (g.tenant_id,g.invitation_id)=(i.tenant_id,i.id)
      WHERE i.tenant_id=$1 AND ($2::uuid IS NULL OR i.id>$2)
      ORDER BY i.id LIMIT 21`,
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
          replacesInvitationId: row.replaces_invitation_id,
          permissions: row.permissions,
        })),
        nextCursor: result.rows.length > 20 ? (page.at(-1)?.id ?? null) : null,
      };
    },
  );
}
