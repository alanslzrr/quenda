import type { Pool, PoolClient } from "pg";
import { command } from "../../database/command.ts";
import { HttpError } from "../../http/errors.ts";
import type { AuthenticatedAccount } from "./auth.ts";

/** Recommendations are on until the account turns them off. */
export async function recommendationsEnabled(
  client: PoolClient,
  accountId: string,
) {
  const row = (
    await client.query<{ recommendations: boolean }>(
      "SELECT recommendations FROM domain.account_preferences WHERE account_id=$1",
      [accountId],
    )
  ).rows[0];
  return row?.recommendations ?? true;
}

export async function saveRecommendationPreference(
  pool: Pool,
  actor: AuthenticatedAccount,
  enabled: boolean,
) {
  if (typeof enabled !== "boolean") throw new HttpError("INVALID_INPUT");
  return command(
    pool,
    { accountId: actor.accountId, tenantId: null },
    async (client) => {
      await client.query(
        "INSERT INTO domain.account_preferences(account_id,recommendations) VALUES($1,$2) ON CONFLICT(account_id) DO UPDATE SET recommendations=EXCLUDED.recommendations",
        [actor.accountId, enabled],
      );
      return { enabled };
    },
  );
}
