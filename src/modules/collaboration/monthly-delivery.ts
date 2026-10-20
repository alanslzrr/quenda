import { Temporal } from "@js-temporal/polyfill";
import { DatabaseError, type Pool } from "pg";
import { command } from "../../database/command.ts";
import { HttpError } from "../../http/errors.ts";
import {
  type AuthenticatedAccount,
  requirePermission,
} from "../identity/index.ts";
export async function deliverMonthlyReport(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  agreementId: string,
  month: string,
) {
  try {
    if (
      !/^\d{4}-\d{2}$/.test(month) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        agreementId,
      )
    )
      throw new HttpError("INVALID_INPUT");
    const start = Temporal.PlainYearMonth.from(month)
      .toPlainDate({ day: 1 })
      .toString();
    return await command(
      pool,
      { accountId: actor.accountId, tenantId },
      async (client) => {
        await requirePermission(client, actor, "REPORT_READ");
        const row = (
          await client.query<{ report: unknown }>(
            "SELECT domain.deliver_monthly_report($1,$2) AS report",
            [agreementId, start],
          )
        ).rows[0];
        if (!row) throw new Error("Missing report delivery");
        return row.report;
      },
    );
  } catch (error) {
    if (error instanceof RangeError) throw new HttpError("INVALID_INPUT");
    if (error instanceof DatabaseError) {
      if (error.code === "42501") throw new HttpError("FORBIDDEN");
      if (error.code === "23514") throw new HttpError("INVALID_INPUT");
    }
    throw error;
  }
}
