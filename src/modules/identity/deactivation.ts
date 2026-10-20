import type { Pool } from "pg";
import { command } from "../../database/command.ts";
import { HttpError } from "../../http/errors.ts";
import type { AuthenticatedAccount } from "./auth.ts";

export async function deactivateAccount(
  pool: Pool,
  actor: AuthenticatedAccount,
  correlationId: string,
) {
  return command(
    pool,
    { accountId: actor.accountId, tenantId: null },
    async (client) => {
      const result = (
        await client.query<{
          outcome:
            | "DEACTIVATED"
            | "INACTIVE"
            | "FUTURE_RESERVATIONS"
            | "HANDOVER_REQUIRED";
          deactivated_at: Date | null;
        }>("SELECT * FROM domain.deactivate_current_account($1)", [
          correlationId,
        ])
      ).rows[0];
      if (result?.outcome === "FUTURE_RESERVATIONS")
        throw new HttpError("ACCOUNT_HAS_FUTURE_RESERVATIONS");
      if (result?.outcome === "HANDOVER_REQUIRED")
        throw new HttpError("ACCOUNT_HANDOVER_REQUIRED");
      if (result?.outcome !== "DEACTIVATED" || !result.deactivated_at)
        throw new HttpError("ACCOUNT_INACTIVE");
      return {
        status: "DEACTIVATED" as const,
        deactivatedAt: result.deactivated_at.toISOString(),
      };
    },
  );
}
