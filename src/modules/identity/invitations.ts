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
  input: { accountId: string; expiresAt: string },
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
        const future = await client.query<{ valid: boolean }>(
          "SELECT $1::timestamptz > now() AS valid",
          [input.expiresAt],
        );
        if (!future.rows[0]?.valid) throw new HttpError("INVALID_INPUT");
        await client.query(
          "INSERT INTO domain.administrator_invitation (tenant_id,id,account_id,invited_by,expires_at,grant_source) VALUES ($1,$2,$3,$4,$5,'MUNICIPAL')",
          [
            tenantId,
            invitationId,
            input.accountId,
            actor.accountId,
            input.expiresAt,
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
  return command(
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
}
