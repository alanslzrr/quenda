import { DatabaseError, type Pool } from "pg";
import { idempotentCommand } from "../../database/idempotency.ts";
import { HttpError } from "../../http/errors.ts";
import {
  type AuthenticatedAccount,
  requireAdministrator,
} from "../identity/index.ts";

export interface ActivateAgreementInput {
  version: number;
  legalReviewReference: string;
  reportReviewReference: string | null;
}
export async function activateAgreement(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  agreementId: string,
  key: string,
  input: ActivateAgreementInput,
  correlationId: string,
  retentionSeconds: number,
) {
  const legalReviewReference = input.legalReviewReference.trim(),
    reportReviewReference = input.reportReviewReference?.trim() ?? null;
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      agreementId,
    ) ||
    !Number.isSafeInteger(input.version) ||
    input.version < 1 ||
    input.version > 2147483647 ||
    !legalReviewReference ||
    legalReviewReference.length > 500 ||
    (reportReviewReference !== null &&
      (!reportReviewReference || reportReviewReference.length > 500))
  )
    throw new HttpError("INVALID_INPUT");
  agreementId = agreementId.toLowerCase();
  try {
    return await idempotentCommand(
      pool,
      { accountId: actor.accountId, tenantId },
      {
        operation: "agreement.activate",
        key,
        input: {
          agreementId,
          version: input.version,
          legalReviewReference,
          reportReviewReference,
        },
        retentionSeconds,
        authorize: async (client) => {
          await requireAdministrator(client, actor);
          if (
            !(
              await client.query(
                "SELECT 1 FROM domain.agreement_version WHERE agreement_id=$1 AND version=$2",
                [agreementId, input.version],
              )
            ).rowCount
          )
            throw new HttpError("NOT_FOUND");
        },
        execute: async (client) => {
          await client.query(
            "SELECT domain.activate_agreement($1,$2,$3,$4,$5)",
            [
              agreementId,
              input.version,
              legalReviewReference,
              reportReviewReference,
              correlationId,
            ],
          );
          return { agreementId, version: input.version, status: "ACTIVADO" };
        },
      },
    );
  } catch (error) {
    if (error instanceof DatabaseError) {
      if (
        ["23514", "23505", "23P01", "40001", "40P01"].includes(error.code ?? "")
      )
        throw new HttpError("CONFLICT");
      if (error.code === "P0002") throw new HttpError("NOT_FOUND");
      if (error.code === "42501") throw new HttpError("FORBIDDEN");
    }
    throw error;
  }
}
