import { Temporal } from "@js-temporal/polyfill";
import { DatabaseError, type Pool } from "pg";
import { command } from "../../database/command.ts";
import { HttpError } from "../../http/errors.ts";
import {
  assessMonthlyAggregate,
  type MonthlyAggregateInput,
} from "./monthly-aggregate.ts";

// Worker-only: never register as a user-facing route or return its raw source.
export async function assessPersistedMonthlyAggregate(
  worker: Pool,
  agreementId: string,
  month: string,
) {
  try {
    if (!/^\d{4}-\d{2}$/.test(month)) throw new HttpError("INVALID_INPUT");
    const start = Temporal.PlainYearMonth.from(month)
      .toPlainDate({ day: 1 })
      .toString();
    return await command(worker, undefined, async (client) => {
      const source = (
        await client.query<{ source: MonthlyAggregateInput }>(
          "SELECT domain.monthly_report_source($1,$2) AS source",
          [agreementId, start],
        )
      ).rows[0]?.source;
      if (!source) throw new Error("Missing monthly report source");
      return {
        agreementId,
        month,
        timeZone: source.timeZone,
        asOf: source.asOf,
        assessment: assessMonthlyAggregate(source),
      };
    });
  } catch (error) {
    if (error instanceof RangeError) throw new HttpError("INVALID_INPUT");
    if (error instanceof DatabaseError) {
      if (error.code === "23514" || error.code === "22P02")
        throw new HttpError("INVALID_INPUT");
      if (error.code === "42501") throw new HttpError("FORBIDDEN");
      if (error.code === "P0002") throw new HttpError("NOT_FOUND");
    }
    throw error;
  }
}
