import type { Pool } from "pg";
import { command } from "../../database/command.ts";
import { HttpError } from "../../http/errors.ts";
import {
  type AuthenticatedAccount,
  accountLabels,
  requireAdministrator,
} from "../identity/index.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Summary = {
  agreement_id: string;
  name: string;
  timezone: string;
  version: number;
  status: "BORRADOR" | "APROBADO" | "ACTIVADO" | "SUSPENDIDO";
  starts_at: Date;
  ends_at: Date;
};
const present = (row: Summary) => ({
  agreementId: row.agreement_id,
  name: row.name,
  timeZone: row.timezone,
  version: row.version,
  status: row.status,
  startsAt: row.starts_at.toISOString(),
  endsAt: row.ends_at.toISOString(),
});
export async function listAgreementVersions(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  after: string | null = null,
) {
  const cursor = after?.split(":") ?? null;
  if (
    cursor &&
    (cursor.length !== 2 ||
      !uuid.test(cursor[0] ?? "") ||
      !/^[1-9][0-9]*$/.test(cursor[1] ?? "") ||
      Number(cursor[1]) > 2147483647)
  )
    throw new HttpError("INVALID_INPUT");
  return command(
    pool,
    { accountId: actor.accountId, tenantId },
    async (client) => {
      await requireAdministrator(client, actor);
      const result = await client.query<Summary>(
        `SELECT v.agreement_id,a.name,a.timezone,v.version,v.status,v.starts_at,v.ends_at
       FROM domain.agreement_version v JOIN domain.agreement a ON a.id=v.agreement_id
       WHERE ($1::uuid IS NULL OR (v.agreement_id,v.version)>($1::uuid,$2::integer))
       ORDER BY v.agreement_id,v.version LIMIT 21`,
        [cursor?.[0] ?? null, cursor ? Number(cursor[1]) : null],
      );
      const page = result.rows.slice(0, 20),
        last = page.at(-1);
      return {
        items: page.map(present),
        nextCursor:
          result.rows.length > 20 && last
            ? `${last.agreement_id}:${last.version}`
            : null,
      };
    },
  );
}
export async function readAgreementVersion(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  agreementId: string,
  version: number,
) {
  if (
    !uuid.test(agreementId) ||
    !Number.isSafeInteger(version) ||
    version < 1 ||
    version > 2147483647
  )
    throw new HttpError("INVALID_INPUT");
  return command(
    pool,
    { accountId: actor.accountId, tenantId },
    async (client) => {
      await requireAdministrator(client, actor);
      const result = await client.query<
        Summary & {
          purpose: string;
          legal_basis: string;
          responsibilities: string;
          retention_policy: string;
          eligibility: "acceso_abierto" | "acreditacion_vigente";
          weekly_limit: number | null;
          aggregate_reports: boolean;
          legal_review_reference: string | null;
          report_review_reference: string | null;
          created_by: string;
          created_at: Date;
          correlation_id: string;
        }
      >(
        "SELECT v.*,a.name,a.timezone FROM domain.agreement_version v JOIN domain.agreement a ON a.id=v.agreement_id WHERE v.agreement_id=$1 AND v.version=$2",
        [agreementId, version],
      );
      const row = result.rows[0];
      if (!row) throw new HttpError("NOT_FOUND");
      const participants = await client.query<{
        tenant_id: string;
        accreditation_issuer: boolean;
      }>(
        "SELECT tenant_id,accreditation_issuer FROM domain.agreement_participant WHERE agreement_id=$1 AND version=$2 ORDER BY tenant_id",
        [agreementId, version],
      );
      const units = await client.query<{ tenant_id: string; unit_id: string }>(
        "SELECT tenant_id,unit_id FROM domain.agreement_unit WHERE agreement_id=$1 AND version=$2 ORDER BY tenant_id,unit_id",
        [agreementId, version],
      );
      const approvals = await client.query<{
        tenant_id: string;
        approved_by: string;
        approved_at: Date;
        correlation_id: string;
      }>(
        "SELECT tenant_id,approved_by,approved_at,correlation_id FROM domain.agreement_approval WHERE agreement_id=$1 AND version=$2 ORDER BY tenant_id",
        [agreementId, version],
      );
      const approvers = await accountLabels(
        client,
        approvals.rows
          .filter((a) => a.tenant_id === tenantId)
          .map((a) => a.approved_by),
      );
      // As with approvals, the author is disclosed only to its own municipality.
      const own = await client.query(
        "SELECT 1 FROM domain.municipal_administrator WHERE tenant_id=$1 AND account_id=$2",
        [tenantId, row.created_by],
      );
      return {
        ...present(row),
        purpose: row.purpose,
        legalBasis: row.legal_basis,
        responsibilities: row.responsibilities,
        retentionPolicy: row.retention_policy,
        eligibility: row.eligibility,
        weeklyLimit: row.weekly_limit,
        aggregateReports: row.aggregate_reports,
        legalReviewReference: row.legal_review_reference,
        reportReviewReference: row.report_review_reference,
        createdBy: own.rowCount ? row.created_by : null,
        createdAt: row.created_at.toISOString(),
        correlationId: row.correlation_id,
        participants: participants.rows.map((p) => ({
          tenantId: p.tenant_id,
          accreditationIssuer: p.accreditation_issuer,
          unitIds: units.rows
            .filter((u) => u.tenant_id === p.tenant_id)
            .map((u) => u.unit_id),
        })),
        approvals: approvals.rows.map((a) => ({
          tenantId: a.tenant_id,
          // Another participant's approver is that municipality's own data; evidence of its approval remains.
          approvedBy: a.tenant_id === tenantId ? a.approved_by : null,
          approvedByLabel:
            a.tenant_id === tenantId
              ? (approvers.get(a.approved_by) ?? null)
              : null,
          approvedAt: a.approved_at.toISOString(),
          correlationId: a.correlation_id,
        })),
      };
    },
  );
}
