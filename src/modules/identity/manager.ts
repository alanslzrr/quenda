import { randomUUID } from "node:crypto";
import { DatabaseError, type Pool, type PoolClient } from "pg";
import { command } from "../../database/command.ts";
import { HttpError } from "../../http/errors.ts";
import { requireAdministrator } from "./administrator.ts";
import type { AuthenticatedAccount } from "./auth.ts";
import { requireMfaSession, requireRecentMfa } from "./reauthentication.ts";

export const operations = [
  "CATALOG_CREATE",
  "CATALOG_MANAGE",
  "RESERVATION_READ",
  "RESERVATION_MANAGE",
  "UNIT_BLOCK",
  "REPORT_READ",
  "DATA_EXPORT",
  "PRIVACY_READ",
  "PRIVACY_EXECUTE",
] as const;
export type Operation = (typeof operations)[number];
export interface ManagerInvitationInput {
  accountId: string;
  replacesInvitationId?: string;
  reason?: string;
  expiresAt: string;
  roleExpiresAt?: string | null;
  permissions: Array<{ operation: Operation; unitId: string | null }>;
}
export async function requirePermission(
  client: PoolClient,
  actor: AuthenticatedAccount,
  operation: Operation,
  unitId: string | null = null,
) {
  requireMfaSession(actor);
  if (!["RESERVATION_READ", "REPORT_READ"].includes(operation))
    requireRecentMfa(actor);
  const result = await client.query<{ allowed: boolean; actor: string }>(
    "SELECT domain.lock_permission($1,$2) AS allowed,current_setting('quenda.account_id',true) AS actor",
    [operation, unitId],
  );
  if (!result.rows[0]?.allowed || result.rows[0].actor !== actor.accountId)
    throw new HttpError("FORBIDDEN");
}
export async function inviteManager(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  input: ManagerInvitationInput,
) {
  if (
    !input.permissions.length ||
    input.permissions.length > 50 ||
    !Number.isFinite(Date.parse(input.expiresAt)) ||
    (input.roleExpiresAt != null &&
      !Number.isFinite(Date.parse(input.roleExpiresAt)))
  )
    throw new HttpError("INVALID_INPUT");
  if (
    input.replacesInvitationId &&
    (!input.reason?.trim() || input.reason.trim().length > 500)
  )
    throw new HttpError("INVALID_INPUT");
  const keys = new Set<string>();
  for (const permission of input.permissions) {
    if (
      !operations.includes(permission.operation) ||
      (["CATALOG_CREATE", "PRIVACY_READ", "PRIVACY_EXECUTE"].includes(
        permission.operation,
      ) &&
        permission.unitId !== null)
    )
      throw new HttpError("INVALID_INPUT");
    const key = JSON.stringify([permission.operation, permission.unitId]);
    if (keys.has(key)) throw new HttpError("INVALID_INPUT");
    keys.add(key);
  }
  const invitationId = randomUUID();
  try {
    return await command(
      pool,
      { accountId: actor.accountId, tenantId },
      async (client) => {
        await requireAdministrator(client, actor);
        const result = await client.query<{ allowed: boolean }>(
          "SELECT domain.invite_manager($1,$2,$3,$4,$5,$6,$7) AS allowed",
          [
            invitationId,
            input.accountId,
            input.expiresAt,
            input.roleExpiresAt ?? null,
            JSON.stringify(input.permissions),
            input.replacesInvitationId ?? null,
            input.reason?.trim() ?? null,
          ],
        );
        if (!result.rows[0]?.allowed) throw new HttpError("FORBIDDEN");
        return { tenantId, invitationId };
      },
    );
  } catch (error) {
    if (
      error instanceof DatabaseError &&
      ["23503", "23514", "23505", "22P02"].includes(error.code ?? "")
    )
      throw new HttpError("INVALID_INPUT");
    throw error;
  }
}
export async function acceptManager(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  invitationId: string,
) {
  return command(
    pool,
    { accountId: actor.accountId, tenantId },
    async (client) => {
      requireRecentMfa(actor);
      const result = await client.query<{ allowed: boolean }>(
        "SELECT domain.accept_manager($1) AS allowed",
        [invitationId],
      );
      if (!result.rows[0]?.allowed) throw new HttpError("NOT_FOUND");
      return { tenantId, invitationId };
    },
  );
}
export async function revokeManager(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  invitationId: string,
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
      const result = await client.query<{ allowed: boolean }>(
        "SELECT domain.revoke_manager($1,$2) AS allowed",
        [invitationId, rationale],
      );
      if (!result.rows[0]?.allowed) throw new HttpError("NOT_FOUND");
      return { tenantId, invitationId };
    },
  );
}

export async function listOwnManagerInvitations(
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
        status: string;
        permissions: Array<
          ManagerInvitationInput["permissions"][number] & {
            unitName: string | null;
          }
        >;
        replaces_invitation_id: string | null;
      }>("SELECT * FROM domain.own_manager_invitations($1)", [after]);
      const page = result.rows.slice(0, 20);
      return {
        items: page.map((row) => ({
          invitationId: row.id,
          tenantId: row.tenant_id,
          municipality: row.municipality,
          expiresAt: row.expires_at.toISOString(),
          roleExpiresAt: row.role_expires_at?.toISOString() ?? null,
          status: row.status,
          permissions: row.permissions,
          replacesInvitationId: row.replaces_invitation_id,
        })),
        nextCursor: result.rows.length > 20 ? (page.at(-1)?.id ?? null) : null,
      };
    },
  );
}
