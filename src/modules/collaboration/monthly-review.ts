import { Temporal } from "@js-temporal/polyfill";
import { DatabaseError, type Pool } from "pg";
import { idempotentCommand } from "../../database/idempotency.ts";
import { HttpError } from "../../http/errors.ts";
import { civilMonth } from "../../shared/civil-date.ts";
import {
  type AuthenticatedAccount,
  requireAdministrator,
} from "../identity/index.ts";
export interface MonthlyRiskReviewInput {
  month: string;
  revision: number;
  recipientTenantId: string;
  recipientAccountId: string;
  expectedHistoryDigest: string;
  decision: "APPROVE" | "REJECT";
  auxiliaryReference: string;
  ownDataReference: string;
  priorReleasesReference: string;
  correctionReference: string | null;
}
export async function reviewMonthlyAssessment(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  agreementId: string,
  key: string,
  input: MonthlyRiskReviewInput,
  correlationId: string,
  retentionSeconds: number,
) {
  try {
    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (
      !uuid.test(agreementId) ||
      !uuid.test(input.recipientTenantId) ||
      !/^\d{4}-\d{2}$/.test(input.month) ||
      !Number.isSafeInteger(input.revision) ||
      input.revision < 1 ||
      input.revision > 2147483647 ||
      !input.recipientAccountId ||
      input.recipientAccountId.length > 200 ||
      !/^[0-9a-f]{64}$/.test(input.expectedHistoryDigest) ||
      !["APPROVE", "REJECT"].includes(input.decision)
    )
      throw new HttpError("INVALID_INPUT");
    const evidence = {
      decision: input.decision,
      auxiliaryReference: input.auxiliaryReference.trim(),
      ownDataReference: input.ownDataReference.trim(),
      priorReleasesReference: input.priorReleasesReference.trim(),
      correctionReference: input.correctionReference?.trim() ?? null,
    };
    if (
      [
        evidence.auxiliaryReference,
        evidence.ownDataReference,
        evidence.priorReleasesReference,
      ].some((v) => !v || v.length > 500) ||
      (evidence.correctionReference !== null &&
        (!evidence.correctionReference ||
          evidence.correctionReference.length > 500)) ||
      (input.revision > 1 && evidence.correctionReference === null)
    )
      throw new HttpError("INVALID_INPUT");
    const month = Temporal.PlainYearMonth.from(civilMonth(input.month))
      .toPlainDate({ day: 1 })
      .toString();
    const agreement = agreementId.toLowerCase(),
      recipientTenant = input.recipientTenantId.toLowerCase();
    const scope = [
      agreement,
      month,
      input.revision,
      recipientTenant,
      input.recipientAccountId,
    ];
    return await idempotentCommand(
      pool,
      { accountId: actor.accountId, tenantId },
      {
        operation: "monthly.review",
        key,
        retentionSeconds,
        input: {
          agreementId: agreement,
          month: input.month,
          revision: input.revision,
          recipientTenantId: recipientTenant,
          recipientAccountId: input.recipientAccountId,
          expectedHistoryDigest: input.expectedHistoryDigest,
          ...evidence,
        },
        authorize: async (client) => {
          await requireAdministrator(client, actor);
          const history = (
            await client.query<{ digest: string }>(
              "SELECT domain.monthly_review_context($1,$2,$3,$4,$5) AS digest",
              scope,
            )
          ).rows[0]?.digest;
          if (history !== input.expectedHistoryDigest)
            throw new HttpError("CONFLICT");
        },
        execute: async (client) => {
          const row = (
            await client.query<{ id: string }>(
              "SELECT domain.record_monthly_risk_review($1,$2,$3,$4,$5,$6,$7,$8) AS id",
              [
                ...scope,
                input.expectedHistoryDigest,
                JSON.stringify(evidence),
                correlationId,
              ],
            )
          ).rows[0];
          if (!row) throw new Error("Missing risk review");
          return {
            reviewId: row.id,
            agreementId: agreement,
            month: input.month,
            revision: input.revision,
            decision: input.decision,
          };
        },
      },
    );
  } catch (error) {
    if (error instanceof RangeError) throw new HttpError("INVALID_INPUT");
    if (error instanceof DatabaseError) {
      if (error.code === "42501") throw new HttpError("FORBIDDEN");
      if (error.code === "P0002") throw new HttpError("NOT_FOUND");
      if (["P0001", "23514"].includes(error.code ?? ""))
        throw new HttpError("CONFLICT");
    }
    throw error;
  }
}
