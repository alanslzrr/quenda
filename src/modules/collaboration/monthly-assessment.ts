import { Temporal } from "@js-temporal/polyfill";
import { DatabaseError, type Pool } from "pg";
import { command } from "../../database/command.ts";
import { HttpError } from "../../http/errors.ts";
import { civilMonth } from "../../shared/civil-date.ts";
import {
  assessMonthlyAggregate,
  type MonthlyAggregateInput,
} from "./monthly-aggregate.ts";

export function prepareMonthlyAssessment(
  worker: Pool,
  agreementId: string,
  month: string,
  expectedRevision: number,
) {
  if (
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0 ||
    expectedRevision >= 2147483647
  )
    throw new HttpError("INVALID_INPUT");
  return runAssessment(worker, agreementId, month, expectedRevision);
}

// Worker-only: never register as a user-facing route or return its raw source.
export async function assessPersistedMonthlyAggregate(
  worker: Pool,
  agreementId: string,
  month: string,
) {
  return runAssessment(worker, agreementId, month);
}
async function runAssessment(
  worker: Pool,
  agreementId: string,
  month: string,
  expectedRevision?: number,
) {
  try {
    if (!/^\d{4}-\d{2}$/.test(month)) throw new HttpError("INVALID_INPUT");
    const start = Temporal.PlainYearMonth.from(civilMonth(month))
      .toPlainDate({ day: 1 })
      .toString();
    return await command(worker, undefined, async (client) => {
      if (expectedRevision !== undefined)
        await client.query("SELECT domain.lock_monthly_assessment($1,$2,$3)", [
          agreementId,
          start,
          expectedRevision,
        ]);
      const source = (
        await client.query<{ source: MonthlyAggregateInput }>(
          "SELECT domain.monthly_report_source($1,$2) AS source",
          [agreementId, start],
        )
      ).rows[0]?.source;
      if (!source) throw new Error("Missing monthly report source");
      const assessment = assessMonthlyAggregate(source);
      const revision =
        expectedRevision === undefined
          ? undefined
          : (
              await client.query<{ revision: number }>(
                "SELECT domain.record_monthly_assessment($1,$2,$3,$4,$5) AS revision",
                [
                  agreementId,
                  start,
                  expectedRevision,
                  JSON.stringify(source),
                  JSON.stringify(assessment),
                ],
              )
            ).rows[0]?.revision;
      if (expectedRevision !== undefined && revision === undefined)
        throw new Error("Missing assessment revision");
      return {
        ...(revision === undefined ? {} : { revision }),
        agreementId,
        month,
        timeZone: source.timeZone,
        asOf: source.asOf,
        assessment,
      };
    });
  } catch (error) {
    if (error instanceof RangeError) throw new HttpError("INVALID_INPUT");
    if (error instanceof DatabaseError) {
      if (error.code === "23514" || error.code === "22P02")
        throw new HttpError("INVALID_INPUT");
      if (error.code === "P0001") throw new HttpError("CONFLICT");
      if (error.code === "42501") throw new HttpError("FORBIDDEN");
      if (error.code === "P0002") throw new HttpError("NOT_FOUND");
    }
    throw error;
  }
}
