import type { Pool } from "pg";
import { command } from "../../database/command.ts";
import { HttpError } from "../../http/errors.ts";
import type { AuthenticatedAccount } from "./auth.ts";
export type ThemePreference = "light" | "dark" | "system" | null;
export async function accountTheme(
  pool: Pool,
  actor: AuthenticatedAccount,
  update?: { theme: ThemePreference },
) {
  if (
    update &&
    update.theme !== null &&
    update.theme !== "light" &&
    update.theme !== "dark" &&
    update.theme !== "system"
  )
    throw new HttpError("INVALID_INPUT");
  return command(
    pool,
    { accountId: actor.accountId, tenantId: null },
    async (client) => {
      if (update)
        await client.query(
          "INSERT INTO domain.account_preferences(account_id,theme) VALUES($1,$2) ON CONFLICT(account_id) DO UPDATE SET theme=EXCLUDED.theme",
          [actor.accountId, update.theme],
        );
      const row = (
        await client.query<{ theme: ThemePreference }>(
          "SELECT theme FROM domain.account_preferences WHERE account_id=$1",
          [actor.accountId],
        )
      ).rows[0];
      return { theme: row?.theme ?? null };
    },
  );
}
