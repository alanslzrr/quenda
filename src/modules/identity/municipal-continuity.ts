import { randomUUID } from "node:crypto";
import { DatabaseError, type Pool } from "pg";
import { command } from "../../database/command.ts";
import { HttpError } from "../../http/errors.ts";
import { requireAdministrator } from "./administrator.ts";
import type { AuthenticatedAccount } from "./auth.ts";
import { invitationAddress } from "./invitation-address.ts";
import { municipalityExists } from "./municipality.ts";
import { requireOperator } from "./operator.ts";

function reason(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 500) throw new HttpError("INVALID_INPUT");
  return trimmed;
}

export async function makeAdministratorIndefinite(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  accountId: string,
  rationale: string,
) {
  const explanation = reason(rationale);
  try {
    return await command(
      pool,
      { accountId: actor.accountId, tenantId },
      async (client) => {
        await requireAdministrator(client, actor);
        const result = await client.query<{ allowed: boolean }>(
          "SELECT domain.make_administrator_indefinite($1,$2) AS allowed",
          [accountId, explanation],
        );
        if (!result.rows[0]?.allowed) throw new HttpError("NOT_FOUND");
        return { tenantId, accountId };
      },
    );
  } catch (error) {
    // Only an indefinite administrator converts another one's grant.
    if (error instanceof DatabaseError && error.code === "42501")
      throw new HttpError("FORBIDDEN");
    throw error;
  }
}

export async function revokeMunicipalAccessForSecurity(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  accountId: string,
  rationale: string,
) {
  const explanation = reason(rationale);
  return command(
    pool,
    { accountId: actor.accountId, tenantId },
    async (client) => {
      await requireAdministrator(client, actor);
      const result = await client.query<{ allowed: boolean }>(
        "SELECT domain.revoke_municipal_access_for_security($1,$2) AS allowed",
        [accountId, explanation],
      );
      if (!result.rows[0]?.allowed) throw new HttpError("NOT_FOUND");
      return { tenantId, accountId };
    },
  );
}

/**
 * Withdraws for security the pending invitations of this municipality that
 * are addressed to an email nobody has accepted yet. The administrator already
 * sees that address in the invitation history; no account is looked up, and
 * NOT_FOUND only means there was no pending invitation to it.
 */
export async function revokeAddressInvitationsForSecurity(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  email: string,
  rationale: string,
) {
  const recipient = invitationAddress(email);
  const explanation = reason(rationale);
  return command(
    pool,
    { accountId: actor.accountId, tenantId },
    async (client) => {
      await requireAdministrator(client, actor);
      const result = await client.query<{ revoked: boolean }>(
        "SELECT domain.revoke_address_invitations_for_security($1,$2) AS revoked",
        [recipient, explanation],
      );
      if (!result.rows[0]?.revoked) throw new HttpError("NOT_FOUND");
      return { tenantId, email: recipient };
    },
  );
}

/**
 * The substitute is invited by address and never looked up: a missing or
 * disabled account simply cannot accept. The operator's own address is
 * rejected, since the issuing operator can never accept a recovery.
 */
export async function recoverMunicipalAdministrator(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  input: {
    email: string;
    expiresAt: string;
    reason: string;
    verificationReference: string;
  },
) {
  const recipient = invitationAddress(input.email);
  const rationale = reason(input.reason);
  const verification = reason(input.verificationReference);
  if (
    recipient === actor.email.trim().toLowerCase() ||
    !Number.isFinite(Date.parse(input.expiresAt))
  )
    throw new HttpError("INVALID_INPUT");
  const invitationId = randomUUID();
  try {
    return await command(
      pool,
      { accountId: actor.accountId, tenantId },
      async (client) => {
        await requireOperator(client, actor);
        const future = await client.query<{ valid: boolean }>(
          "SELECT $1::timestamptz>now() AS valid",
          [input.expiresAt],
        );
        if (!future.rows[0]?.valid) throw new HttpError("INVALID_INPUT");
        const result = await client.query<{ allowed: boolean }>(
          "SELECT domain.recover_municipal_administrator($1,$2,$3,$4,$5) AS allowed",
          [recipient, input.expiresAt, rationale, verification, invitationId],
        );
        if (!result.rows[0]?.allowed)
          throw new HttpError(
            (await municipalityExists(client, tenantId))
              ? "ADMINISTRATOR_RECOVERY_UNAVAILABLE"
              : "NOT_FOUND",
          );
        return { tenantId, invitationId };
      },
    );
  } catch (error) {
    if (
      error instanceof DatabaseError &&
      ["22023", "23514"].includes(error.code ?? "")
    )
      throw new HttpError("INVALID_INPUT");
    throw error;
  }
}
