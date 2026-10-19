import type { PoolClient } from "pg";
import { HttpError } from "../../http/errors.ts";
import type { AuthenticatedAccount } from "./auth.ts";
import { requireRecentMfa } from "./reauthentication.ts";

// Caller establishes the account context and keeps this lock until its command
// commits. Revocation takes an incompatible lock and subsequent commands fail.
export async function requireOperator(
  client: PoolClient,
  account: AuthenticatedAccount,
): Promise<void> {
  requireRecentMfa(account);
  const operator = await client.query<{ allowed: boolean }>(
    "SELECT domain.lock_current_operator() AS allowed",
  );
  const context = await client.query<{ account: string }>(
    "SELECT current_setting('quenda.account_id', true) AS account",
  );
  if (
    context.rows[0]?.account !== account.accountId ||
    operator.rows[0]?.allowed !== true
  )
    throw new HttpError("FORBIDDEN");
}
