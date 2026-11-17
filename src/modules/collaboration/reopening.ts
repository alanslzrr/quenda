import { DatabaseError, type Pool } from "pg";
import { command } from "../../database/command.ts";
import { idempotentCommand } from "../../database/idempotency.ts";
import { HttpError } from "../../http/errors.ts";
import {
  type AuthenticatedAccount,
  requireAdministrator,
} from "../identity/index.ts";
import { agreementRejection } from "./conflicts.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function translate(error: unknown): never {
  if (error instanceof DatabaseError) {
    if (error.code === "23514") throw new HttpError(agreementRejection(error));
    if (["40001", "40P01"].includes(error.code ?? ""))
      throw new HttpError("CONFLICT");
    if (error.code === "P0002") throw new HttpError("NOT_FOUND");
    if (error.code === "42501") throw new HttpError("FORBIDDEN");
  }
  throw error;
}
export async function readUnitAgreementRestriction(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  unitId: string,
) {
  if (!uuid.test(unitId)) throw new HttpError("INVALID_INPUT");
  try {
    return await command(
      pool,
      { accountId: actor.accountId, tenantId },
      async (client) => {
        await requireAdministrator(client, actor);
        const result = await client.query<{
          agreement_id: string;
          version: number;
          has_remaining_assignment: boolean;
        }>("SELECT * FROM domain.read_unit_agreement_restriction($1)", [
          unitId,
        ]);
        const row = result.rows[0];
        return {
          unitId,
          restriction: row
            ? {
                agreementId: row.agreement_id,
                version: row.version,
                hasRemainingAssignment: row.has_remaining_assignment,
              }
            : null,
        };
      },
    );
  } catch (error) {
    return translate(error);
  }
}
export interface ReleaseAgreementRestrictionInput {
  expectedAgreementId: string;
  expectedVersion: number;
  reason: string;
}
export async function releaseUnitAgreementRestriction(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  unitId: string,
  key: string,
  input: ReleaseAgreementRestrictionInput,
  correlationId: string,
  retentionSeconds: number,
) {
  const reason = input.reason.trim();
  if (
    !uuid.test(unitId) ||
    !uuid.test(input.expectedAgreementId) ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 1 ||
    input.expectedVersion > 2147483647 ||
    !reason ||
    reason.length > 500
  )
    throw new HttpError("INVALID_INPUT");
  unitId = unitId.toLowerCase();
  const expectedAgreementId = input.expectedAgreementId.toLowerCase();
  try {
    return await idempotentCommand(
      pool,
      { accountId: actor.accountId, tenantId },
      {
        operation: "agreement.restriction.release",
        key,
        input: {
          unitId,
          expectedAgreementId,
          expectedVersion: input.expectedVersion,
          reason,
        },
        retentionSeconds,
        authorize: async (client) => {
          await requireAdministrator(client, actor);
          if (
            !(
              await client.query(
                "SELECT 1 FROM domain.reservable_unit WHERE tenant_id=$1 AND id=$2",
                [tenantId, unitId],
              )
            ).rowCount
          )
            throw new HttpError("NOT_FOUND");
        },
        execute: async (client) => {
          const result = await client.query<{ removed: boolean }>(
            "SELECT domain.release_unit_agreement_restriction($1,$2,$3,$4,$5) AS removed",
            [
              unitId,
              expectedAgreementId,
              input.expectedVersion,
              reason,
              correlationId,
            ],
          );
          const row = result.rows[0];
          if (!row) throw new Error("Missing agreement restriction result");
          return { unitId, removed: row.removed };
        },
      },
    );
  } catch (error) {
    return translate(error);
  }
}
