import { DatabaseError, type Pool } from "pg";
import { command } from "../../database/command.ts";
import { HttpError } from "../../http/errors.ts";
import type { AuthenticatedAccount } from "./auth.ts";
import { requirePrivacyPermission } from "./privacy-permissions.ts";

export interface SharedRetentionTarget {
  ownerTenantId: string;
  category: "RESERVATIONS" | "ACCREDITATIONS";
  targetKey: string;
  action: "ERASE" | "BLOCK";
  blockDays?: number;
}
export interface SharedRetentionContext
  extends Omit<SharedRetentionTarget, "blockDays"> {
  blockDays: number | null;
  digest: string;
  controllers: Array<{ tenantId: string; name: string; approved: boolean }>;
}
export interface SharedRetentionReview extends SharedRetentionTarget {
  digest: string;
  approved: boolean;
  authorizationReference: string;
  reason: string;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validate(input: SharedRetentionTarget) {
  if (
    !uuid.test(input.ownerTenantId) ||
    !uuid.test(input.targetKey) ||
    !["RESERVATIONS", "ACCREDITATIONS"].includes(input.category) ||
    !["ERASE", "BLOCK"].includes(input.action) ||
    (input.action === "BLOCK"
      ? !Number.isInteger(input.blockDays) ||
        (input.blockDays ?? 0) < 1 ||
        (input.blockDays ?? 0) > 365000
      : input.blockDays !== undefined)
  )
    throw new HttpError("INVALID_INPUT");
}
function failure(error: unknown): never {
  if (error instanceof DatabaseError) {
    if (error.code === "42501") throw new HttpError("FORBIDDEN");
    if (error.code === "22023") throw new HttpError("INVALID_INPUT");
    if (error.code === "55000") throw new HttpError("UNAVAILABLE");
  }
  throw error;
}
export async function sharedRetentionContext(
  pool: Pool,
  actor: AuthenticatedAccount,
  reviewer: string,
  input: SharedRetentionTarget,
): Promise<SharedRetentionContext> {
  validate(input);
  try {
    return await command(
      pool,
      { accountId: actor.accountId, tenantId: reviewer },
      async (client) => {
        await requirePrivacyPermission(client, actor, "PRIVACY_READ", reviewer);
        const result = await client.query<{
          data: SharedRetentionContext | null;
        }>(
          "SELECT domain.shared_retention_context($1,$2,$3,$4,$5,$6) AS data",
          [
            reviewer,
            input.ownerTenantId,
            input.category,
            input.targetKey,
            input.action,
            input.blockDays ?? null,
          ],
        );
        if (!result.rows[0]?.data) throw new HttpError("NOT_FOUND");
        return result.rows[0].data;
      },
    );
  } catch (error) {
    failure(error);
  }
}
export async function reviewSharedRetention(
  pool: Pool,
  actor: AuthenticatedAccount,
  reviewer: string,
  input: SharedRetentionReview,
  correlationId: string,
) {
  validate(input);
  if (
    !/^[a-f0-9]{64}$/.test(input.digest) ||
    typeof input.approved !== "boolean" ||
    [input.authorizationReference, input.reason].some(
      (v) => !v.trim() || v.trim().length > 500,
    )
  )
    throw new HttpError("INVALID_INPUT");
  try {
    return await command(
      pool,
      { accountId: actor.accountId, tenantId: reviewer },
      async (client) => {
        await requirePrivacyPermission(
          client,
          actor,
          "PRIVACY_EXECUTE",
          reviewer,
        );
        await requirePrivacyPermission(client, actor, "PRIVACY_READ", reviewer);
        const result = await client.query<{ outcome: string }>(
          "SELECT domain.review_shared_retention($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) AS outcome",
          [
            reviewer,
            input.ownerTenantId,
            input.category,
            input.targetKey,
            input.action,
            input.blockDays ?? null,
            input.digest,
            input.approved,
            input.authorizationReference.trim(),
            input.reason.trim(),
            correlationId,
          ],
        );
        const outcome = result.rows[0]?.outcome;
        if (outcome === "OK")
          return { digest: input.digest, approved: input.approved };
        if (
          outcome === "FORBIDDEN" ||
          outcome === "NOT_FOUND" ||
          outcome === "CONFLICT" ||
          outcome === "INVALID_INPUT"
        )
          throw new HttpError(outcome);
        throw new HttpError("INTERNAL_ERROR");
      },
    );
  } catch (error) {
    failure(error);
  }
}
