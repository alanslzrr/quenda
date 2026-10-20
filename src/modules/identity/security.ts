import type { Pool } from "pg";
import { command } from "../../database/command.ts";
import { HttpError } from "../../http/errors.ts";
import type { AuthenticatedAccount } from "./auth.ts";
import { requireOperator } from "./operator.ts";

export async function suspendAccount(
  pool: Pool,
  actor: AuthenticatedAccount,
  accountId: string,
  reason: string,
  correlationId: string,
) {
  if (!reason.trim() || reason.length > 500)
    throw new HttpError("INVALID_INPUT");
  return command(
    pool,
    { accountId: actor.accountId, tenantId: null },
    async (client) => {
      await requireOperator(client, actor);
      const result = await client.query<{ suspended_at: Date | null }>(
        "SELECT domain.suspend_account($1,$2,$3) AS suspended_at",
        [accountId, reason.trim(), correlationId],
      );
      const instant = result.rows[0]?.suspended_at;
      if (!instant) throw new HttpError("NOT_FOUND");
      return { accountId, suspendedAt: instant.toISOString() };
    },
  );
}
