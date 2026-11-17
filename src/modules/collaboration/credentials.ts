import { randomUUID } from "node:crypto";
import { Temporal } from "@js-temporal/polyfill";
import { DatabaseError, type Pool } from "pg";
import { idempotentCommand } from "../../database/idempotency.ts";
import { HttpError } from "../../http/errors.ts";
import {
  type AuthenticatedAccount,
  requireAdministrator,
} from "../identity/index.ts";
import { agreementRejection } from "./conflicts.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function reference(value: string) {
  const normalized = value.trim();
  if (!normalized || normalized.length > 500)
    throw new HttpError("INVALID_INPUT");
  return normalized;
}
function translate(error: unknown): never {
  if (error instanceof DatabaseError) {
    if (error.code === "P0002") throw new HttpError("NOT_FOUND");
    if (error.code === "42501") throw new HttpError("FORBIDDEN");
    if (error.code === "23514") throw new HttpError(agreementRejection(error));
    if (["40001", "40P01"].includes(error.code ?? ""))
      throw new HttpError("CONFLICT");
  }
  throw error;
}
export interface IssueCredentialInput {
  agreementId: string;
  version: number;
  accountId: string;
  startsAt: string;
  endsAt: string;
  verificationReference: string;
}
export async function issueAgreementCredential(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  key: string,
  input: IssueCredentialInput,
  correlationId: string,
  retentionSeconds: number,
) {
  if (
    !uuid.test(input.agreementId) ||
    !Number.isSafeInteger(input.version) ||
    input.version < 1 ||
    input.version > 2147483647 ||
    !input.accountId ||
    input.accountId.length > 200 ||
    input.accountId.includes("\0")
  )
    throw new HttpError("INVALID_INPUT");
  let starts: Temporal.Instant, ends: Temporal.Instant;
  try {
    starts = Temporal.Instant.from(input.startsAt);
    ends = Temporal.Instant.from(input.endsAt);
  } catch {
    throw new HttpError("INVALID_INPUT");
  }
  if (
    Temporal.Instant.compare(starts, ends) >= 0 ||
    starts.epochNanoseconds % 1_000_000n ||
    ends.epochNanoseconds % 1_000_000n
  )
    throw new HttpError("INVALID_INPUT");
  const normalized = {
    ...input,
    agreementId: input.agreementId.toLowerCase(),
    startsAt: starts.toString({ smallestUnit: "millisecond" }),
    endsAt: ends.toString({ smallestUnit: "millisecond" }),
    verificationReference: reference(input.verificationReference),
  };
  try {
    return await idempotentCommand(
      pool,
      { accountId: actor.accountId, tenantId },
      {
        operation: "agreement.credential.issue",
        key,
        input: { ...normalized },
        retentionSeconds,
        authorize: async (client) => {
          await requireAdministrator(client, actor);
          const issuer = await client.query(
            "SELECT 1 FROM domain.agreement_participant WHERE agreement_id=$1 AND version=$2 AND tenant_id=$3 AND accreditation_issuer",
            [normalized.agreementId, input.version, tenantId],
          );
          if (!issuer.rowCount) throw new HttpError("NOT_FOUND");
        },
        execute: async (client) => {
          const id = randomUUID();
          await client.query(
            "SELECT domain.issue_agreement_credential($1,$2,$3,$4,$5,$6,$7,$8)",
            [
              id,
              normalized.agreementId,
              input.version,
              input.accountId,
              normalized.startsAt,
              normalized.endsAt,
              normalized.verificationReference,
              correlationId,
            ],
          );
          return {
            id,
            agreementId: normalized.agreementId,
            version: input.version,
            revoked: false,
          };
        },
      },
    );
  } catch (error) {
    return translate(error);
  }
}
export async function revokeAgreementCredential(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  credentialId: string,
  key: string,
  reason: string,
  correlationId: string,
  retentionSeconds: number,
) {
  if (!uuid.test(credentialId)) throw new HttpError("INVALID_INPUT");
  credentialId = credentialId.toLowerCase();
  reason = reference(reason);
  try {
    return await idempotentCommand(
      pool,
      { accountId: actor.accountId, tenantId },
      {
        operation: "agreement.credential.revoke",
        key,
        input: { credentialId, reason },
        retentionSeconds,
        authorize: async (client) => {
          await requireAdministrator(client, actor);
          const visible = await client.query<{ visible: boolean }>(
            "SELECT domain.issued_credential_visible($1) AS visible",
            [credentialId],
          );
          if (!visible.rows[0]?.visible) throw new HttpError("NOT_FOUND");
        },
        execute: async (client) => {
          await client.query(
            "SELECT domain.revoke_agreement_credential($1,$2,$3)",
            [credentialId, reason, correlationId],
          );
          return { id: credentialId, revoked: true };
        },
      },
    );
  } catch (error) {
    return translate(error);
  }
}
