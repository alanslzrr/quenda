import { randomUUID } from "node:crypto";
import { Temporal } from "@js-temporal/polyfill";
import { DatabaseError, type Pool } from "pg";
import { idempotentCommand } from "../../database/idempotency.ts";
import { HttpError } from "../../http/errors.ts";
import {
  type AuthenticatedAccount,
  requireAdministrator,
} from "../identity/index.ts";
import { weeklyQuotaPeriod } from "./quota-period.ts";

export interface AgreementDraftInput {
  name: string;
  timeZone: string;
  startsAt: string;
  endsAt: string;
  purpose: string;
  legalBasis: string;
  responsibilities: string;
  retentionPolicy: string;
  eligibility: "acceso_abierto" | "acreditacion_vigente";
  weeklyLimit: number | null;
  aggregateReports: boolean;
  participants: Array<{
    tenantId: string;
    accreditationIssuer: boolean;
    unitIds: string[];
  }>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function text(value: string, max = 2000) {
  const result = value.trim();
  if (!result || result.length > max) throw new HttpError("INVALID_INPUT");
  return result;
}
function instant(value: string) {
  try {
    const result = Temporal.Instant.from(value);
    if (result.epochNanoseconds % 1_000_000n !== 0n)
      throw new HttpError("INVALID_INPUT");
    return result.toString({ smallestUnit: "millisecond" });
  } catch (error) {
    if (error instanceof RangeError) throw new HttpError("INVALID_INPUT");
    throw error;
  }
}
export type AgreementVersionInput = Omit<
  AgreementDraftInput,
  "name" | "timeZone"
>;

export function normalizeAgreementVersion(
  input: AgreementVersionInput,
  tenantId: string,
): AgreementVersionInput {
  const startsAt = instant(input.startsAt),
    endsAt = instant(input.endsAt);
  if (
    Temporal.Instant.compare(startsAt, endsAt) >= 0 ||
    !["acceso_abierto", "acreditacion_vigente"].includes(input.eligibility) ||
    (input.weeklyLimit !== null &&
      (!Number.isSafeInteger(input.weeklyLimit) ||
        input.weeklyLimit < 1 ||
        input.weeklyLimit > 2147483647)) ||
    typeof input.aggregateReports !== "boolean"
  )
    throw new HttpError("INVALID_INPUT");
  const participants = input.participants
    .map((p) => {
      if (
        !uuid.test(p.tenantId) ||
        typeof p.accreditationIssuer !== "boolean" ||
        p.unitIds.some((id) => !uuid.test(id))
      )
        throw new HttpError("INVALID_INPUT");
      const unitIds = p.unitIds.map((id) => id.toLowerCase()).sort();
      if (new Set(unitIds).size !== unitIds.length)
        throw new HttpError("INVALID_INPUT");
      return {
        tenantId: p.tenantId.toLowerCase(),
        accreditationIssuer: p.accreditationIssuer,
        unitIds,
      };
    })
    .sort((a, b) => a.tenantId.localeCompare(b.tenantId));
  if (
    new Set(participants.map((p) => p.tenantId)).size !== participants.length ||
    !participants.some((p) => p.tenantId === tenantId.toLowerCase())
  )
    throw new HttpError("INVALID_INPUT");
  return {
    startsAt,
    endsAt,
    purpose: text(input.purpose),
    legalBasis: text(input.legalBasis),
    responsibilities: text(input.responsibilities),
    retentionPolicy: text(input.retentionPolicy),
    eligibility: input.eligibility,
    weeklyLimit: input.weeklyLimit,
    aggregateReports: input.aggregateReports,
    participants,
  };
}
export function normalizeAgreementDraft(
  input: AgreementDraftInput,
  tenantId: string,
): AgreementDraftInput {
  const normalized = normalizeAgreementVersion(input, tenantId);
  weeklyQuotaPeriod(normalized.startsAt, input.timeZone);
  return {
    ...normalized,
    name: text(input.name, 200),
    timeZone: input.timeZone,
  };
}

export async function createAgreementDraft(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  key: string,
  input: AgreementDraftInput,
  correlationId: string,
  retentionSeconds: number,
) {
  const normalized = normalizeAgreementDraft(input, tenantId);
  try {
    return await idempotentCommand(
      pool,
      { accountId: actor.accountId, tenantId },
      {
        operation: "agreement.create",
        key,
        input: { ...normalized },
        retentionSeconds,
        authorize: (client) => requireAdministrator(client, actor),
        execute: async (client) => {
          const agreementId = randomUUID();
          await client.query(
            "SELECT domain.create_agreement_draft($1,$2::jsonb,$3)",
            [agreementId, JSON.stringify(normalized), correlationId],
          );
          return { agreementId, version: 1, status: "BORRADOR" };
        },
      },
    );
  } catch (error) {
    if (error instanceof DatabaseError && error.code === "23503")
      throw new HttpError("NOT_FOUND");
    // The database is stricter than the local parser, for example about the
    // exact spelling of a time zone name.
    if (error instanceof DatabaseError && error.code === "23514")
      throw new HttpError("INVALID_INPUT");
    throw error;
  }
}
