import { randomUUID } from "node:crypto";
import { DatabaseError, type Pool } from "pg";
import { command } from "../../database/command.ts";
import { HttpError } from "../../http/errors.ts";
import type { AuthenticatedAccount } from "./auth.ts";
import { invitationAddress } from "./invitation-address.ts";
import { platformAccountNames } from "./platform-account-names.ts";
import { requireRecentMfa } from "./reauthentication.ts";

function outcome(value: string | undefined): void {
  switch (value) {
    case "OK":
      return;
    case "HANDOVER_REQUIRED":
      throw new HttpError("ACCOUNT_HANDOVER_REQUIRED");
    case "CONFLICT":
      // The accepting account is already an operator, or the address already
      // has a pending invitation.
      throw new HttpError("ROLE_ALREADY_ACTIVE");
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

/**
 * The invitation is addressed to an email address. No account is looked up,
 * so the response is the same whether or not one uses that address. Only the
 * issuing operator's own address is rejected.
 */
export async function inviteOperator(
  pool: Pool,
  actor: AuthenticatedAccount,
  input: { email: string; expiresAt: string },
) {
  requireRecentMfa(actor);
  const recipient = invitationAddress(input.email);
  if (
    recipient === actor.email.trim().toLowerCase() ||
    !Number.isFinite(Date.parse(input.expiresAt))
  )
    throw new HttpError("INVALID_INPUT");
  const invitationId = randomUUID();
  try {
    return await command(
      pool,
      { accountId: actor.accountId, tenantId: null },
      async (client) => {
        const result = await client.query<{ outcome: string }>(
          "SELECT domain.invite_operator($1,$2,$3,$4) AS outcome",
          [recipient, input.expiresAt, invitationId, randomUUID()],
        );
        outcome(result.rows[0]?.outcome);
        return { invitationId };
      },
    );
  } catch (error) {
    if (error instanceof DatabaseError && error.code === "23514")
      throw new HttpError("INVALID_INPUT");
    throw error;
  }
}

export async function acceptOperatorInvitation(
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
        "SELECT domain.accept_operator_invitation($1,$2) AS outcome",
        [invitationId, randomUUID()],
      );
      outcome(result.rows[0]?.outcome);
      return { accountId: actor.accountId };
    },
  );
}

export async function revokeOperatorInvitation(
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
        "SELECT domain.revoke_operator_invitation($1,$2,$3) AS outcome",
        [invitationId, explanation, randomUUID()],
      );
      outcome(result.rows[0]?.outcome);
      return { invitationId };
    },
  );
}

export async function revokeOperator(
  pool: Pool,
  actor: AuthenticatedAccount,
  accountId: string,
  rationale: string,
) {
  requireRecentMfa(actor);
  const explanation = reason(rationale);
  return command(
    pool,
    { accountId: actor.accountId, tenantId: null },
    async (client) => {
      const result = await client.query<{ outcome: string }>(
        "SELECT domain.revoke_operator($1,$2,$3) AS outcome",
        [accountId, explanation, randomUUID()],
      );
      outcome(result.rows[0]?.outcome);
      return { accountId };
    },
  );
}

type InvitationRow = {
  id: string;
  account_id?: string | null;
  recipient_email?: string | null;
  invited_by?: string;
  expires_at: Date;
  status: "PENDING" | "ACCEPTED" | "REVOKED" | "EXPIRED";
};

async function invitations(
  pool: Pool,
  actor: AuthenticatedAccount,
  after: string | null,
  own: boolean,
) {
  if (!own) requireRecentMfa(actor);
  try {
    return await command(
      pool,
      { accountId: actor.accountId, tenantId: null },
      async (client) => {
        const result = await client.query<InvitationRow>(
          own
            ? "SELECT * FROM domain.own_operator_invitations($1)"
            : "SELECT * FROM domain.list_operator_invitations($1)",
          [after],
        );
        const page = result.rows.slice(0, 20);
        const names = own
          ? new Map<string, string>()
          : await platformAccountNames(
              client,
              page.flatMap((row) => [row.account_id, row.invited_by]),
            );
        return {
          items: page.map((row) => ({
            invitationId: row.id,
            ...(own
              ? {}
              : {
                  accountId: row.account_id ?? null,
                  recipientEmail: row.recipient_email ?? null,
                  accountName: names.get(row.account_id ?? "") ?? null,
                  invitedBy: row.invited_by,
                  invitedByName: names.get(row.invited_by ?? "") ?? null,
                }),
            expiresAt: row.expires_at.toISOString(),
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

export const listOwnOperatorInvitations = (
  pool: Pool,
  actor: AuthenticatedAccount,
  after: string | null = null,
) => invitations(pool, actor, after, true);

export const listOperatorInvitations = (
  pool: Pool,
  actor: AuthenticatedAccount,
  after: string | null = null,
) => invitations(pool, actor, after, false);

export async function listOperators(
  pool: Pool,
  actor: AuthenticatedAccount,
  after: string | null = null,
) {
  requireRecentMfa(actor);
  try {
    return await command(
      pool,
      { accountId: actor.accountId, tenantId: null },
      async (client) => {
        const result = await client.query<{
          account_id: string;
          granted_at: Date;
          revoked_at: Date | null;
          active: boolean;
        }>("SELECT * FROM domain.list_platform_operators($1)", [after]);
        const page = result.rows.slice(0, 20);
        const names = await platformAccountNames(
          client,
          page.map((row) => row.account_id),
        );
        return {
          items: page.map((row) => ({
            accountId: row.account_id,
            accountName: names.get(row.account_id) ?? null,
            grantedAt: row.granted_at.toISOString(),
            revokedAt: row.revoked_at?.toISOString() ?? null,
            active: row.active,
          })),
          nextCursor:
            result.rows.length > 20 ? (page.at(-1)?.account_id ?? null) : null,
        };
      },
    );
  } catch (error) {
    if (error instanceof DatabaseError && error.code === "42501")
      throw new HttpError("FORBIDDEN");
    throw error;
  }
}
