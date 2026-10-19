import { DatabaseError, type Pool } from "pg";
import { idempotentCommand } from "../../database/idempotency.ts";
import { HttpError } from "../../http/errors.ts";
import {
  type AuthenticatedAccount,
  requireAdministrator,
} from "../identity/index.ts";
import {
  type AgreementVersionInput,
  normalizeAgreementVersion,
} from "./drafts.ts";

export async function createAgreementVersion(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  agreementId: string,
  key: string,
  input: AgreementVersionInput & { expectedVersion: number },
  correlationId: string,
  retentionSeconds: number,
) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      agreementId,
    ) ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 1 ||
    input.expectedVersion >= 2147483647
  )
    throw new HttpError("INVALID_INPUT");
  agreementId = agreementId.toLowerCase();
  const normalized = normalizeAgreementVersion(input, tenantId);
  try {
    return await idempotentCommand(
      pool,
      { accountId: actor.accountId, tenantId },
      {
        operation: "agreement.version",
        key,
        input: {
          agreementId,
          expectedVersion: input.expectedVersion,
          ...normalized,
        },
        retentionSeconds,
        authorize: async (client) => {
          await requireAdministrator(client, actor);
          const visible = await client.query(
            "SELECT 1 FROM domain.agreement_version WHERE agreement_id=$1 AND version=$2",
            [agreementId, input.expectedVersion],
          );
          if (!visible.rowCount) throw new HttpError("NOT_FOUND");
        },
        execute: async (client) => {
          const result = await client.query<{ version: number }>(
            "SELECT domain.create_agreement_version($1,$2,$3::jsonb,$4) AS version",
            [
              agreementId,
              input.expectedVersion,
              JSON.stringify(normalized),
              correlationId,
            ],
          );
          const row = result.rows[0];
          if (!row) throw new Error("Missing agreement version result");
          return { agreementId, version: row.version, status: "BORRADOR" };
        },
      },
    );
  } catch (error) {
    if (error instanceof DatabaseError) {
      if (["23514", "40001", "40P01"].includes(error.code ?? ""))
        throw new HttpError("CONFLICT");
      if (["23503", "P0002"].includes(error.code ?? ""))
        throw new HttpError("NOT_FOUND");
      if (error.code === "42501") throw new HttpError("FORBIDDEN");
    }
    throw error;
  }
}
