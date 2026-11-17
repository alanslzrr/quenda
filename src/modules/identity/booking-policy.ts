import type { Pool } from "pg";
import { command } from "../../database/command.ts";
import { HttpError } from "../../http/errors.ts";
import { requireAdministrator } from "./administrator.ts";
import type { AuthenticatedAccount } from "./auth.ts";

export interface BookingPolicyInput {
  expectedVersion: number;
  advanceDays: number;
  cancellationMinutes: number;
  reason: string;
}
export async function readBookingPolicy(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
) {
  return command(
    pool,
    { accountId: actor.accountId, tenantId },
    async (client) => {
      await requireAdministrator(client, actor);
      const row = (
        await client.query<{
          booking_policy_version: number;
          advance_days: number;
          cancellation_minutes: number;
        }>(
          "SELECT booking_policy_version,advance_days,cancellation_minutes FROM domain.municipality WHERE id=$1",
          [tenantId],
        )
      ).rows[0];
      if (!row) throw new HttpError("NOT_FOUND");
      return {
        tenantId,
        version: row.booking_policy_version,
        advanceDays: row.advance_days,
        cancellationMinutes: row.cancellation_minutes,
      };
    },
  );
}
export async function saveBookingPolicy(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  input: BookingPolicyInput,
  correlationId: string,
) {
  if (
    !Number.isInteger(input.expectedVersion) ||
    input.expectedVersion < 1 ||
    input.expectedVersion >= 2147483647 ||
    ![input.advanceDays, input.cancellationMinutes].every(
      (n) => Number.isInteger(n) && n >= 0 && n <= 2147483647,
    ) ||
    !input.reason.trim() ||
    input.reason.trim().length > 500
  )
    throw new HttpError("INVALID_INPUT");
  return command(
    pool,
    { accountId: actor.accountId, tenantId },
    async (client) => {
      await requireAdministrator(client, actor);
      const result = await client.query<{ version: number | null }>(
        "SELECT domain.save_municipal_booking_policy($1,$2,$3,$4,$5) AS version",
        [
          input.expectedVersion,
          input.advanceDays,
          input.cancellationMinutes,
          input.reason.trim(),
          correlationId,
        ],
      );
      const version = result.rows[0]?.version;
      if (version == null) {
        // The function also refuses a limit below a unit's own advance; only a
        // moved version means that someone else saved first.
        const current = await client.query<{ booking_policy_version: number }>(
          "SELECT booking_policy_version FROM domain.municipality WHERE id=$1",
          [tenantId],
        );
        throw new HttpError(
          current.rows[0]?.booking_policy_version === input.expectedVersion
            ? "UNIT_ADVANCE_EXCEEDS_LIMIT"
            : "STALE_VERSION",
        );
      }
      return {
        tenantId,
        version,
        advanceDays: input.advanceDays,
        cancellationMinutes: input.cancellationMinutes,
      };
    },
  );
}
