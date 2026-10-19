import type { Pool } from "pg";
import { command } from "../../database/command.ts";
import { HttpError } from "../../http/errors.ts";
import type { AuthenticatedAccount } from "./auth.ts";
export async function readAccountPreferences(
  pool: Pool,
  actor: AuthenticatedAccount,
) {
  return command(
    pool,
    { accountId: actor.accountId, tenantId: null },
    async (client) => {
      const row = (
        await client.query<{ locale: "es" | "gl" | null }>(
          "SELECT locale FROM domain.account_preferences WHERE account_id=$1",
          [actor.accountId],
        )
      ).rows[0];
      return { locale: row?.locale ?? null };
    },
  );
}
export async function saveAccountPreferences(
  pool: Pool,
  actor: AuthenticatedAccount,
  locale: "es" | "gl" | null,
) {
  if (locale !== null && locale !== "es" && locale !== "gl")
    throw new HttpError("INVALID_INPUT");
  return command(
    pool,
    { accountId: actor.accountId, tenantId: null },
    async (client) => {
      await client.query(
        "INSERT INTO domain.account_preferences(account_id,locale) VALUES($1,$2) ON CONFLICT(account_id) DO UPDATE SET locale=EXCLUDED.locale",
        [actor.accountId, locale],
      );
      return { locale };
    },
  );
}
