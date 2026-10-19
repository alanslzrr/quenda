import { DatabaseError, type Pool } from "pg";
import { idempotentCommand } from "../../database/idempotency.ts";
import { HttpError } from "../../http/errors.ts";
import {
  type AuthenticatedAccount,
  requireAdministrator,
} from "../identity/index.ts";

export interface AgreementApprovalInput {
  version: number;
  unitIds: string[];
}
export async function approveAgreement(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  agreementId: string,
  key: string,
  input: AgreementApprovalInput,
  correlationId: string,
  retentionSeconds: number,
) {
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const unitIds = input.unitIds.map((id) => id.toLowerCase()).sort();
  if (
    !uuid.test(agreementId) ||
    !Number.isSafeInteger(input.version) ||
    input.version < 1 ||
    input.version > 2147483647 ||
    unitIds.some((id) => !uuid.test(id)) ||
    new Set(unitIds).size !== unitIds.length
  )
    throw new HttpError("INVALID_INPUT");
  agreementId = agreementId.toLowerCase();
  try {
    return await idempotentCommand(
      pool,
      { accountId: actor.accountId, tenantId },
      {
        operation: "agreement.approve",
        key,
        input: { agreementId, version: input.version, unitIds },
        retentionSeconds,
        authorize: async (client) => {
          await requireAdministrator(client, actor);
          const visible = await client.query(
            "SELECT 1 FROM domain.agreement_version WHERE agreement_id=$1 AND version=$2",
            [agreementId, input.version],
          );
          if (!visible.rowCount) throw new HttpError("NOT_FOUND");
        },
        execute: async (client) => {
          const result = await client.query<{
            status: "BORRADOR" | "APROBADO";
          }>("SELECT domain.approve_agreement($1,$2,$3::uuid[],$4) AS status", [
            agreementId,
            input.version,
            unitIds,
            correlationId,
          ]);
          const row = result.rows[0];
          if (!row) throw new Error("Missing agreement approval result");
          return {
            agreementId,
            version: input.version,
            status: row.status,
          };
        },
      },
    );
  } catch (error) {
    if (error instanceof DatabaseError) {
      if (["23514", "40001", "40P01"].includes(error.code ?? ""))
        throw new HttpError("CONFLICT");
      if (error.code === "P0002") throw new HttpError("NOT_FOUND");
      if (error.code === "42501") throw new HttpError("FORBIDDEN");
    }
    throw error;
  }
}
