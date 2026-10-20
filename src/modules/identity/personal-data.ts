import { DatabaseError, type Pool } from "pg";
import { command } from "../../database/command.ts";
import { HttpError } from "../../http/errors.ts";
import type { AuthenticatedAccount } from "./auth.ts";
import { requirePrivacyPermission } from "./privacy-permissions.ts";

export type PersonalDataCategory =
  | "IDENTITY"
  | "AUTHENTICATION"
  | "MUNICIPAL_PROFILE"
  | "RESERVATIONS"
  | "COMMUNICATIONS"
  | "AUTHORITY"
  | "ACCREDITATIONS";

export interface PersonalDataExport {
  format: "quenda.personal-data";
  version: 1;
  generatedAt: string;
  subjectAccountId: string;
  scope: { kind: "SELF" | "MUNICIPAL" | "GLOBAL"; tenantId: string | null };
  completeness: {
    status: "PARTIAL";
    projectedRecordsIncluded: true;
    legalAccessResponseComplete: false;
    portabilityAssessment: "NOT_ASSESSED";
    restrictedCategories: {
      category: PersonalDataCategory;
      tenantId: string | null;
    }[];
    reviewRequired: string[];
    excludedSecurityMaterial: string[];
    administrativeChannel: string;
    controllerInformationStatus: "NOT_CONFIGURED";
  };
  records: {
    category: PersonalDataCategory;
    tenantId: string | null;
    type: string;
    data: Record<string, unknown>;
  }[];
}

export interface PersonalDataAuthorization {
  reason: string;
  authorizationReference: string;
}

async function exportData(
  pool: Pool,
  actor: AuthenticatedAccount,
  subjectAccountId: string,
  mode: "SELF" | "MUNICIPAL" | "GLOBAL",
  tenantId: string | null,
  authorization: PersonalDataAuthorization | null,
  correlationId: string,
): Promise<PersonalDataExport> {
  if (
    !subjectAccountId ||
    subjectAccountId.length > 128 ||
    (authorization !== null &&
      [authorization.reason, authorization.authorizationReference].some(
        (value) => !value.trim() || value.length > 500,
      ))
  )
    throw new HttpError("INVALID_INPUT");
  try {
    return await command(
      pool,
      { accountId: actor.accountId, tenantId },
      async (client) => {
        if (mode !== "SELF")
          await requirePrivacyPermission(
            client,
            actor,
            "PRIVACY_READ",
            tenantId,
          );
        const result = await client.query<{ document: PersonalDataExport }>(
          "SELECT domain.export_personal_data($1,$2,$3,$4,$5,$6) AS document",
          [
            subjectAccountId,
            mode,
            tenantId,
            authorization?.reason.trim() ?? null,
            authorization?.authorizationReference.trim() ?? null,
            correlationId,
          ],
        );
        const document = result.rows[0]?.document;
        if (!document) throw new HttpError("NOT_FOUND");
        return document;
      },
    );
  } catch (error) {
    if (error instanceof DatabaseError) {
      if (error.code === "54000")
        throw new HttpError("PERSONAL_DATA_TOO_LARGE");
      if (error.code === "42501") throw new HttpError("FORBIDDEN");
      if (error.code === "P0002") throw new HttpError("NOT_FOUND");
      if (error.code === "22023") throw new HttpError("INVALID_INPUT");
    }
    throw error;
  }
}

export function exportOwnPersonalData(
  pool: Pool,
  actor: AuthenticatedAccount,
  correlationId: string,
) {
  return exportData(
    pool,
    actor,
    actor.accountId,
    "SELF",
    null,
    null,
    correlationId,
  );
}

export function exportMunicipalPersonalData(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  subjectAccountId: string,
  authorization: PersonalDataAuthorization,
  correlationId: string,
) {
  return exportData(
    pool,
    actor,
    subjectAccountId,
    "MUNICIPAL",
    tenantId,
    authorization,
    correlationId,
  );
}

export function exportGlobalPersonalData(
  pool: Pool,
  actor: AuthenticatedAccount,
  subjectAccountId: string,
  authorization: PersonalDataAuthorization,
  correlationId: string,
) {
  return exportData(
    pool,
    actor,
    subjectAccountId,
    "GLOBAL",
    null,
    authorization,
    correlationId,
  );
}
