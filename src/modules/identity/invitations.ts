import { randomUUID } from "node:crypto";
import { DatabaseError, type Pool } from "pg";
import { command } from "../../database/command.ts";
import { HttpError } from "../../http/errors.ts";
import { requireAdministrator } from "./administrator.ts";
import type { AuthenticatedAccount } from "./auth.ts";

export async function inviteAdministrator(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  input: {
    accountId: string;
    expiresAt: string;
    roleExpiresAt?: string | null;
  },
) {
  const invitationId = randomUUID();
  try {
    return await command(
      pool,
      { accountId: actor.accountId, tenantId },
      async (client) => {
        await requireAdministrator(client, actor);
        if (!Number.isFinite(Date.parse(input.expiresAt)))
          throw new HttpError("INVALID_INPUT");
        if (
          input.roleExpiresAt != null &&
          !Number.isFinite(Date.parse(input.roleExpiresAt))
        )
          throw new HttpError("INVALID_INPUT");
        const future = await client.query<{ valid: boolean }>(
          "SELECT $1::timestamptz > now() AND ($2::timestamptz IS NULL OR $2::timestamptz > now()) AS valid",
          [input.expiresAt, input.roleExpiresAt ?? null],
        );
        if (!future.rows[0]?.valid) throw new HttpError("INVALID_INPUT");
        // A temporary administrator cannot grant a role that outlives its own.
        const bounded = await client.query<{ allowed: boolean }>(
          "SELECT domain.administrator_role_within_issuer($1) AS allowed",
          [input.roleExpiresAt ?? null],
        );
        if (!bounded.rows[0]?.allowed) throw new HttpError("FORBIDDEN");
        await client.query(
          "INSERT INTO domain.administrator_invitation (tenant_id,id,account_id,invited_by,expires_at,grant_source,role_expires_at,issuer_invitation_id) VALUES ($1,$2,$3,$4,$5,'MUNICIPAL',$6,(SELECT invitation_id FROM domain.municipal_administrator WHERE tenant_id=$1 AND account_id=$4))",
          [
            tenantId,
            invitationId,
            input.accountId,
            actor.accountId,
            input.expiresAt,
            input.roleExpiresAt ?? null,
          ],
        );
        await client.query(
          "INSERT INTO domain.identity_event (tenant_id,id,actor_id,operation,subject_id,invitation_id) VALUES ($1,$2,$3,'INVITE_ADMINISTRATOR',$4,$5)",
          [
            tenantId,
            randomUUID(),
            actor.accountId,
            input.accountId,
            invitationId,
          ],
        );
        return { tenantId, invitationId };
      },
    );
  } catch (error) {
    if (error instanceof DatabaseError && error.code === "23503")
      throw new HttpError("INVALID_INPUT");
    throw error;
  }
}

export async function revokeAdministratorInvitation(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  invitationId: string,
) {
  return command(
    pool,
    { accountId: actor.accountId, tenantId },
    async (client) => {
      await requireAdministrator(client, actor);
      const result = await client.query<{ subject: string | null }>(
        "SELECT domain.revoke_administrator_invitation($1) AS subject",
        [invitationId],
      );
      const subject = result.rows[0]?.subject;
      if (!subject) throw new HttpError("NOT_FOUND");
      await client.query(
        "INSERT INTO domain.identity_event (tenant_id,id,actor_id,operation,subject_id,invitation_id) VALUES ($1,$2,$3,'REVOKE_INVITATION',$4,$5)",
        [tenantId, randomUUID(), actor.accountId, subject, invitationId],
      );
      return { tenantId, invitationId };
    },
  );
}

export async function revokeAdministrator(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  accountId: string,
  reason: string,
) {
  const rationale = reason.trim();
  if (!rationale || rationale.length > 500)
    throw new HttpError("INVALID_INPUT");
  try {
    return await command(
      pool,
      { accountId: actor.accountId, tenantId },
      async (client) => {
        await requireAdministrator(client, actor);
        const result = await client.query<{ invitation: string | null }>(
          "SELECT domain.revoke_administrator($1,$2) AS invitation",
          [accountId, rationale],
        );
        if (!result.rows[0]?.invitation) throw new HttpError("NOT_FOUND");
        return { tenantId, accountId };
      },
    );
  } catch (error) {
    if (
      error instanceof DatabaseError &&
      error.code === "P0001" &&
      error.message === "HANDOVER_REQUIRED"
    )
      throw new HttpError("ACCOUNT_HANDOVER_REQUIRED");
    throw error;
  }
}

export async function listOwnAdministratorInvitations(
  pool: Pool,
  actor: AuthenticatedAccount,
  after: string | null = null,
) {
  return command(
    pool,
    { accountId: actor.accountId, tenantId: null },
    async (client) => {
      const result = await client.query<{
        id: string;
        tenant_id: string;
        municipality: string;
        expires_at: Date;
        role_expires_at: Date | null;
        status: "PENDING" | "ACCEPTED" | "REVOKED" | "EXPIRED" | "INVALIDATED";
      }>("SELECT * FROM domain.own_administrator_invitations($1)", [after]);
      const page = result.rows.slice(0, 20);
      return {
        items: page.map((row) => ({
          invitationId: row.id,
          tenantId: row.tenant_id,
          municipality: row.municipality,
          expiresAt: row.expires_at.toISOString(),
          roleExpiresAt: row.role_expires_at?.toISOString() ?? null,
          status: row.status,
        })),
        nextCursor: result.rows.length > 20 ? (page.at(-1)?.id ?? null) : null,
      };
    },
  );
}
