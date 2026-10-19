import type { PoolClient } from "pg";
import { HttpError } from "../../http/errors.ts";
import type { AuthenticatedAccount } from "./auth.ts";
import { requireRecentMfa } from "./reauthentication.ts";

export async function requireAdministrator(
  client: PoolClient,
  account: AuthenticatedAccount,
): Promise<void> {
  requireRecentMfa(account);
  const result = await client.query<{ allowed: boolean; actor: string }>(
    "SELECT domain.lock_current_administrator() AS allowed, current_setting('quenda.account_id', true) AS actor",
  );
  if (!result.rows[0]?.allowed || result.rows[0].actor !== account.accountId)
    throw new HttpError("FORBIDDEN");
}
