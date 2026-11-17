import { Temporal } from "@js-temporal/polyfill";
import { DatabaseError, type Pool } from "pg";
import { command } from "../../database/command.ts";
import { HttpError } from "../../http/errors.ts";
import { civilMonth } from "../../shared/civil-date.ts";
import {
  type AuthenticatedAccount,
  requireAdministrator,
} from "../identity/index.ts";
export async function readMonthlyReviewContext(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  agreementId: string,
  month: string,
  revision: number,
  recipientTenantId: string,
  recipientAccountId: string,
) {
  try {
    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (
      !uuid.test(agreementId) ||
      !uuid.test(recipientTenantId) ||
      !/^\d{4}-\d{2}$/.test(month) ||
      !Number.isSafeInteger(revision) ||
      revision < 1 ||
      revision > 2147483647 ||
      !recipientAccountId ||
      recipientAccountId.length > 200
    )
      throw new HttpError("INVALID_INPUT");
    const first = Temporal.PlainYearMonth.from(civilMonth(month))
      .toPlainDate({ day: 1 })
      .toString();
    return await command(
      pool,
      { accountId: actor.accountId, tenantId },
      async (client) => {
        await requireAdministrator(client, actor);
        const row = (
          await client.query<{ digest: string }>(
            "SELECT domain.monthly_review_context($1,$2,$3,$4,$5) AS digest",
            [
              agreementId,
              first,
              revision,
              recipientTenantId,
              recipientAccountId,
            ],
          )
        ).rows[0];
        if (!row) throw new Error("Missing review context");
        return {
          agreementId: agreementId.toLowerCase(),
          month,
          revision,
          recipientTenantId: recipientTenantId.toLowerCase(),
          recipientAccountId,
          historyDigest: row.digest,
        };
      },
    );
  } catch (error) {
    if (error instanceof RangeError) throw new HttpError("INVALID_INPUT");
    if (error instanceof DatabaseError) {
      if (error.code === "42501") throw new HttpError("FORBIDDEN");
      if (error.code === "P0002") throw new HttpError("NOT_FOUND");
      if (error.code === "P0001") throw new HttpError("STALE_VERSION");
    }
    throw error;
  }
}
