import { DatabaseError, type Pool } from "pg";
import { idempotentCommand } from "../../database/idempotency.ts";
import { HttpError } from "../../http/errors.ts";
import {
  type AuthenticatedAccount,
  requireAdministrator,
} from "../identity/index.ts";
import { agreementRejection } from "./conflicts.ts";

export async function suspendAgreement(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  agreementId: string,
  key: string,
  input: { version: number; reason: string },
  correlationId: string,
  retentionSeconds: number,
) {
  const reason = input.reason.trim();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      agreementId,
    ) ||
    !Number.isSafeInteger(input.version) ||
    input.version < 1 ||
    input.version > 2147483647 ||
    !reason ||
    reason.length > 500
  )
    throw new HttpError("INVALID_INPUT");
  agreementId = agreementId.toLowerCase();
  try {
    return await idempotentCommand(
      pool,
      { accountId: actor.accountId, tenantId },
      {
        operation: "agreement.suspend",
        key,
        input: { agreementId, version: input.version, reason },
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
          await client.query("SELECT domain.suspend_agreement($1,$2,$3,$4)", [
            agreementId,
            input.version,
            reason,
            correlationId,
          ]);
          return { agreementId, version: input.version, status: "SUSPENDIDO" };
        },
      },
    );
  } catch (error) {
    if (error instanceof DatabaseError) {
      if (error.code === "23514")
        throw new HttpError(agreementRejection(error));
      if (["40001", "40P01"].includes(error.code ?? ""))
        throw new HttpError("CONFLICT");
      if (error.code === "P0002") throw new HttpError("NOT_FOUND");
      if (error.code === "42501") throw new HttpError("FORBIDDEN");
    }
    throw error;
  }
}
