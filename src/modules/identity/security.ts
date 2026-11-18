import type { Pool } from "pg";
import { command } from "../../database/command.ts";
import { HttpError } from "../../http/errors.ts";
import type { AuthenticatedAccount } from "./auth.ts";
import { requireOperator } from "./operator.ts";

function rationale(reason: string): string {
  if (!reason.trim() || reason.length > 500)
    throw new HttpError("INVALID_INPUT");
  return reason.trim();
}

export async function suspendAccount(
  pool: Pool,
  actor: AuthenticatedAccount,
  accountId: string,
  reason: string,
  correlationId: string,
) {
  const explanation = rationale(reason);
  return command(
    pool,
    { accountId: actor.accountId, tenantId: null },
    async (client) => {
      await requireOperator(client, actor);
      const result = await client.query<{ suspended_at: Date | null }>(
        "SELECT domain.suspend_account($1,$2,$3) AS suspended_at",
        [accountId, explanation, correlationId],
      );
      const instant = result.rows[0]?.suspended_at;
      if (!instant) throw new HttpError("NOT_FOUND");
      return { accountId, suspendedAt: instant.toISOString() };
    },
  );
}

/**
 * Suspends the account whose email is exactly this address, after trimming
 * and lower-casing. Only an operator with recent MFA reaches the lookup, which
 * runs inside the audited suspension; an unknown address answers NOT_FOUND
 * exactly like an unknown identifier. Beyond the 3 to 320 character bounds
 * enforced by the route schema, the address is not format-checked, so a
 * malformed one cannot be told apart from an unknown one either.
 */
export async function suspendAccountByEmail(
  pool: Pool,
  actor: AuthenticatedAccount,
  email: string,
  reason: string,
  correlationId: string,
) {
  const explanation = rationale(reason);
  return command(
    pool,
    { accountId: actor.accountId, tenantId: null },
    async (client) => {
      await requireOperator(client, actor);
      const result = await client.query<{
        account_id: string;
        suspended_at: Date;
      }>("SELECT * FROM domain.suspend_account_by_email($1,$2,$3)", [
        email,
        explanation,
        correlationId,
      ]);
      const row = result.rows[0];
      if (!row) throw new HttpError("NOT_FOUND");
      return {
        accountId: row.account_id,
        suspendedAt: row.suspended_at.toISOString(),
      };
    },
  );
}
