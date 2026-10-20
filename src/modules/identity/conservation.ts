import { randomUUID } from "node:crypto";
import { DatabaseError, type Pool } from "pg";
import { command } from "../../database/command.ts";
import { HttpError } from "../../http/errors.ts";
import type { AuthenticatedAccount } from "./auth.ts";
import { requirePrivacyPermission } from "./privacy-permissions.ts";

export const retentionCategories = [
  "COMMUNICATIONS",
  "RESERVATIONS",
  "MUNICIPAL_PROFILE",
  "AUTHENTICATION",
  "IDENTITY",
  "AUTHORITY",
  "ACCREDITATIONS",
] as const;
export type RetentionCategory = (typeof retentionCategories)[number];
export interface RetentionPolicyInput {
  category: RetentionCategory;
  retentionDays: number;
  action: "ERASE" | "BLOCK";
  blockDays?: number;
  purpose: string;
  controllerReference: string;
  approvalReference: string;
  reason: string;
}
export interface RetentionPolicy
  extends Omit<RetentionPolicyInput, "blockDays"> {
  policyId: string;
  scopeTenantId: string | null;
  blockDays: number | null;
  approvedAt: string;
  revokedAt: string | null;
  supersededAt: string | null;
}
function outcome(value: string | undefined): void {
  switch (value) {
    case "OK":
      return;
    case "INVALID_INPUT":
    case "NOT_FOUND":
    case "FORBIDDEN":
    case "CONFLICT":
      throw new HttpError(value);
    default:
      throw new HttpError("INTERNAL_ERROR");
  }
}
function text(value: string, maximum: number): string {
  const result = value.trim();
  if (!result || result.length > maximum) throw new HttpError("INVALID_INPUT");
  return result;
}
function days(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= 365000;
}
export async function approveRetentionPolicy(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string | null,
  input: RetentionPolicyInput,
  correlationId: string,
) {
  if (
    !retentionCategories.includes(input.category) ||
    !days(input.retentionDays) ||
    (input.action !== "ERASE" && input.action !== "BLOCK") ||
    (input.action === "BLOCK" &&
      (input.blockDays === undefined || !days(input.blockDays))) ||
    (input.action === "ERASE" && input.blockDays !== undefined)
  )
    throw new HttpError("INVALID_INPUT");
  const specification = {
    ...input,
    purpose: text(input.purpose, 500),
    controllerReference: text(input.controllerReference, 500),
    approvalReference: text(input.approvalReference, 500),
    reason: text(input.reason, 500),
  };
  const policyId = randomUUID();
  return command(
    pool,
    { accountId: actor.accountId, tenantId },
    async (client) => {
      await requirePrivacyPermission(
        client,
        actor,
        "PRIVACY_EXECUTE",
        tenantId,
      );
      const result = await client.query<{ outcome: string }>(
        "SELECT domain.approve_retention_policy($1,$2,$3,$4) AS outcome",
        [policyId, tenantId, specification, correlationId],
      );
      outcome(result.rows[0]?.outcome);
      return { policyId };
    },
  );
}
export async function revokeRetentionPolicy(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string | null,
  policyId: string,
  reason: string,
  correlationId: string,
) {
  const rationale = text(reason, 500);
  return command(
    pool,
    { accountId: actor.accountId, tenantId },
    async (client) => {
      await requirePrivacyPermission(
        client,
        actor,
        "PRIVACY_EXECUTE",
        tenantId,
      );
      const result = await client.query<{ outcome: string }>(
        "SELECT domain.revoke_retention_policy($1,$2,$3,$4) AS outcome",
        [policyId, tenantId, rationale, correlationId],
      );
      outcome(result.rows[0]?.outcome);
      return { policyId };
    },
  );
}
export async function listRetentionPolicies(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string | null,
): Promise<{ policies: RetentionPolicy[]; hasMore: boolean }> {
  try {
    return await command(
      pool,
      { accountId: actor.accountId, tenantId },
      async (client) => {
        await requirePrivacyPermission(client, actor, "PRIVACY_READ", tenantId);
        const result = await client.query<{
          data: { policies: RetentionPolicy[]; hasMore: boolean };
        }>("SELECT domain.list_retention_policies($1) AS data", [tenantId]);
        if (!result.rows[0]) throw new HttpError("INTERNAL_ERROR");
        return result.rows[0].data;
      },
    );
  } catch (error) {
    if (error instanceof DatabaseError && error.code === "42501")
      throw new HttpError("FORBIDDEN");
    throw error;
  }
}

export interface RetentionHoldInput {
  category: RetentionCategory;
  targetKey?: string;
  subjectId?: string;
  authorizationReference: string;
  reason: string;
}
export interface RetentionStatus {
  holds: Array<{
    holdId: string;
    category: RetentionCategory;
    targetKey: string | null;
    subjectId: string | null;
    authorizationReference: string;
    reason: string;
    createdAt: string;
  }>;
  conflicts: Array<{
    policyId: string;
    category: RetentionCategory;
    targetKey: string;
    reason: string;
    lastSeenAt: string;
  }>;
  hasMoreHolds: boolean;
  hasMoreConflicts: boolean;
}

export async function setRetentionHold(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string | null,
  input: RetentionHoldInput,
  correlationId: string,
) {
  if (
    !retentionCategories.includes(input.category) ||
    (input.targetKey !== undefined) === (input.subjectId !== undefined)
  )
    throw new HttpError("INVALID_INPUT");
  const specification = {
    category: input.category,
    ...(input.targetKey !== undefined
      ? { targetKey: text(input.targetKey, 500) }
      : { subjectId: text(input.subjectId ?? "", 128) }),
    authorizationReference: text(input.authorizationReference, 500),
    reason: text(input.reason, 500),
  };
  const holdId = randomUUID();
  return command(
    pool,
    { accountId: actor.accountId, tenantId },
    async (client) => {
      await requirePrivacyPermission(
        client,
        actor,
        "PRIVACY_EXECUTE",
        tenantId,
      );
      const result = await client.query<{ outcome: string }>(
        "SELECT domain.set_retention_hold($1,$2,$3,$4) AS outcome",
        [holdId, tenantId, specification, correlationId],
      );
      outcome(result.rows[0]?.outcome);
      return { holdId };
    },
  );
}

export async function releaseRetentionHold(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string | null,
  holdId: string,
  authorizationReference: string,
  reason: string,
  correlationId: string,
) {
  const authorization = text(authorizationReference, 500),
    rationale = text(reason, 500);
  return command(
    pool,
    { accountId: actor.accountId, tenantId },
    async (client) => {
      await requirePrivacyPermission(
        client,
        actor,
        "PRIVACY_EXECUTE",
        tenantId,
      );
      const result = await client.query<{ outcome: string }>(
        "SELECT domain.release_retention_hold($1,$2,$3,$4,$5) AS outcome",
        [holdId, tenantId, authorization, rationale, correlationId],
      );
      outcome(result.rows[0]?.outcome);
      return { holdId };
    },
  );
}

export async function readRetentionStatus(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string | null,
): Promise<RetentionStatus> {
  try {
    return await command(
      pool,
      { accountId: actor.accountId, tenantId },
      async (client) => {
        await requirePrivacyPermission(client, actor, "PRIVACY_READ", tenantId);
        const result = await client.query<{ data: RetentionStatus }>(
          "SELECT domain.retention_status($1) AS data",
          [tenantId],
        );
        if (!result.rows[0]) throw new HttpError("INTERNAL_ERROR");
        return result.rows[0].data;
      },
    );
  } catch (error) {
    if (error instanceof DatabaseError && error.code === "42501")
      throw new HttpError("FORBIDDEN");
    throw error;
  }
}

export interface PrivacyActionInput {
  category: RetentionCategory;
  targetKey: string;
  action: "ERASE" | "BLOCK";
  blockDays?: number;
  authorizationReference: string;
  reason: string;
}
export interface PrivacyActionResult {
  status: "APPLIED" | "CONFLICT" | "ABSENT";
  eventId: string;
  reason?: string;
}
export async function executePrivacyAction(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string | null,
  input: PrivacyActionInput,
  correlationId: string,
): Promise<PrivacyActionResult> {
  if (
    !retentionCategories.includes(input.category) ||
    (input.action !== "ERASE" && input.action !== "BLOCK") ||
    (input.action === "BLOCK" &&
      (input.blockDays === undefined || !days(input.blockDays))) ||
    (input.action === "ERASE" && input.blockDays !== undefined)
  )
    throw new HttpError("INVALID_INPUT");
  const specification = {
    ...input,
    targetKey: text(input.targetKey, 500),
    authorizationReference: text(input.authorizationReference, 500),
    reason: text(input.reason, 500),
  };
  try {
    return await command(
      pool,
      { accountId: actor.accountId, tenantId },
      async (client) => {
        await requirePrivacyPermission(
          client,
          actor,
          "PRIVACY_EXECUTE",
          tenantId,
        );
        const result = await client.query<{ data: PrivacyActionResult }>(
          "SELECT domain.execute_privacy_action($1,$2,$3) AS data",
          [tenantId, specification, correlationId],
        );
        if (!result.rows[0]) throw new HttpError("INTERNAL_ERROR");
        // A denied or absent target is an audited outcome, not a transaction
        // failure: throwing here would erase evidence of the attempted action.
        return result.rows[0].data;
      },
    );
  } catch (error) {
    if (error instanceof DatabaseError) {
      if (error.code === "42501") throw new HttpError("FORBIDDEN");
      if (["23514", "22P02", "22023"].includes(error.code ?? ""))
        throw new HttpError("INVALID_INPUT");
      if (error.code === "55000") throw new HttpError("UNAVAILABLE");
    }
    throw error;
  }
}
