import { randomUUID } from "node:crypto";
import { DatabaseError, type Pool, type PoolClient } from "pg";
import { command } from "../../database/command.ts";
import { HttpError } from "../../http/errors.ts";
import type { AuthenticatedAccount } from "./auth.ts";
import { platformAccountNames } from "./platform-account-names.ts";
import { requireRecentMfa } from "./reauthentication.ts";

export const privacyOperations = ["PRIVACY_READ", "PRIVACY_EXECUTE"] as const;
export type PrivacyOperation = (typeof privacyOperations)[number];
export interface GlobalPrivacyInvitationInput {
  accountId: string;
  permissions: PrivacyOperation[];
  expiresAt: string;
  roleExpiresAt?: string | null;
  reason: string;
}

export async function requirePrivacyPermission(
  client: PoolClient,
  actor: AuthenticatedAccount,
  operation: PrivacyOperation,
  tenantId: string | null,
): Promise<void> {
  requireRecentMfa(actor);
  const result = await client.query<{ allowed: boolean; actor: string }>(
    "SELECT domain.lock_privacy_permission($1,$2) AS allowed,current_setting('quenda.account_id',true) AS actor",
    [operation, tenantId],
  );
  if (!result.rows[0]?.allowed || result.rows[0].actor !== actor.accountId)
    throw new HttpError("FORBIDDEN");
}

function outcome(value: string | undefined): void {
  switch (value) {
    case "OK":
      return;
    case "INVALID_INPUT":
    case "NOT_FOUND":
    case "FORBIDDEN":
      throw new HttpError(value);
    default:
      throw new HttpError("INTERNAL_ERROR");
  }
}
function reason(value: string): string {
  const result = value.trim();
  if (!result || result.length > 500) throw new HttpError("INVALID_INPUT");
  return result;
}

export async function inviteGlobalPrivacy(
  pool: Pool,
  actor: AuthenticatedAccount,
  input: GlobalPrivacyInvitationInput,
) {
  requireRecentMfa(actor);
  const rationale = reason(input.reason);
  if (
    !input.accountId ||
    input.accountId.length > 128 ||
    !Number.isFinite(Date.parse(input.expiresAt)) ||
    (input.roleExpiresAt != null &&
      !Number.isFinite(Date.parse(input.roleExpiresAt))) ||
    !input.permissions.length ||
    input.permissions.length > privacyOperations.length ||
    new Set(input.permissions).size !== input.permissions.length ||
    input.permissions.some(
      (permission) => !privacyOperations.includes(permission),
    )
  )
    throw new HttpError("INVALID_INPUT");
  const invitationId = randomUUID();
  return command(
    pool,
    { accountId: actor.accountId, tenantId: null },
    async (client) => {
      const result = await client.query<{ outcome: string }>(
        "SELECT domain.invite_global_privacy($1,$2,$3,$4,$5,$6) AS outcome",
        [
          input.accountId,
          input.expiresAt,
          input.roleExpiresAt ?? null,
          input.permissions,
          rationale,
          invitationId,
        ],
      );
      outcome(result.rows[0]?.outcome);
      return { invitationId };
    },
  );
}

export async function acceptGlobalPrivacy(
  pool: Pool,
  actor: AuthenticatedAccount,
  invitationId: string,
) {
  requireRecentMfa(actor);
  return command(
    pool,
    { accountId: actor.accountId, tenantId: null },
    async (client) => {
      const result = await client.query<{ outcome: string }>(
        "SELECT domain.accept_global_privacy($1) AS outcome",
        [invitationId],
      );
      outcome(result.rows[0]?.outcome);
      return { invitationId };
    },
  );
}

export async function revokeGlobalPrivacy(
  pool: Pool,
  actor: AuthenticatedAccount,
  invitationId: string,
  rationale: string,
) {
  requireRecentMfa(actor);
  const explanation = reason(rationale);
  return command(
    pool,
    { accountId: actor.accountId, tenantId: null },
    async (client) => {
      const result = await client.query<{ outcome: string }>(
        "SELECT domain.revoke_global_privacy($1,$2) AS outcome",
        [invitationId, explanation],
      );
      outcome(result.rows[0]?.outcome);
      return { invitationId };
    },
  );
}

export async function listGlobalPrivacyInvitations(
  pool: Pool,
  actor: AuthenticatedAccount,
  ownOnly: boolean,
  after: string | null = null,
) {
  if (!ownOnly) requireRecentMfa(actor);
  try {
    return await command(
      pool,
      { accountId: actor.accountId, tenantId: null },
      async (client) => {
        const result = await client.query<{
          id: string;
          account_id: string;
          invited_by: string;
          permissions: PrivacyOperation[];
          reason: string;
          expires_at: Date;
          role_expires_at: Date | null;
          status: "PENDING" | "ACTIVE" | "REVOKED" | "EXPIRED" | "INVALIDATED";
        }>("SELECT * FROM domain.list_global_privacy_invitations($1,$2)", [
          after,
          ownOnly,
        ]);
        const page = result.rows.slice(0, 20);
        const names = ownOnly
          ? new Map<string, string>()
          : await platformAccountNames(
              client,
              page.flatMap((row) => [row.account_id, row.invited_by]),
            );
        return {
          items: page.map((row) => ({
            invitationId: row.id,
            ...(ownOnly
              ? {}
              : {
                  accountId: row.account_id,
                  accountName: names.get(row.account_id) ?? null,
                  invitedBy: row.invited_by,
                  invitedByName: names.get(row.invited_by) ?? null,
                }),
            permissions: row.permissions,
            reason: row.reason,
            expiresAt: row.expires_at.toISOString(),
            roleExpiresAt: row.role_expires_at?.toISOString() ?? null,
            status: row.status,
          })),
          nextCursor:
            result.rows.length > 20 ? (page.at(-1)?.id ?? null) : null,
        };
      },
    );
  } catch (error) {
    if (error instanceof DatabaseError && error.code === "42501")
      throw new HttpError("FORBIDDEN");
    throw error;
  }
}
