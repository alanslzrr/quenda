import type { Pool, PoolClient } from "pg";
import { command } from "../../database/command.ts";
import { HttpError } from "../../http/errors.ts";
import {
  type AuthenticatedAccount,
  requirePermission,
} from "../identity/index.ts";

export interface UsageRulesInput {
  expectedVersion: number;
  text: string;
  reason: string;
}
interface RulesRow {
  version: number;
  text_content: string;
  actor_id: string;
  reason: string;
  correlation_id: string;
  created_at: Date;
}
async function read(
  client: PoolClient,
  tenantId: string,
  unitId: string,
  version: number | null,
) {
  const row = (
    await client.query<RulesRow>(
      `SELECT v.* FROM domain.unit_usage_rules v JOIN domain.reservable_unit u
     ON (u.tenant_id,u.id)=(v.tenant_id,v.unit_id)
     WHERE v.tenant_id=$1 AND v.unit_id=$2 AND v.version=coalesce($3::integer,u.usage_rules_version)`,
      [tenantId, unitId, version],
    )
  ).rows[0];
  if (!row) throw new HttpError("NOT_FOUND");
  return {
    tenantId,
    unitId,
    version: row.version,
    text: row.text_content,
    actorId: row.actor_id,
    reason: row.reason,
    correlationId: row.correlation_id,
    createdAt: row.created_at.toISOString(),
  };
}
export async function saveUsageRules(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  unitId: string,
  input: UsageRulesInput,
  correlationId: string,
) {
  if (
    !Number.isInteger(input.expectedVersion) ||
    input.expectedVersion < 0 ||
    input.expectedVersion >= 2147483647 ||
    typeof input.text !== "string" ||
    !input.text.trim() ||
    input.text.length > 20000 ||
    input.text.includes("\0") ||
    typeof input.reason !== "string" ||
    !input.reason.trim() ||
    input.reason.trim().length > 500 ||
    input.reason.includes("\0")
  )
    throw new HttpError("INVALID_INPUT");
  return command(
    pool,
    { accountId: actor.accountId, tenantId },
    async (client) => {
      await requirePermission(client, actor, "CATALOG_MANAGE", unitId);
      const row = (
        await client.query<{ version: number | null }>(
          "SELECT domain.save_unit_usage_rules($1,$2,$3,$4,$5) AS version",
          [
            unitId,
            input.expectedVersion,
            input.text,
            input.reason.trim(),
            correlationId,
          ],
        )
      ).rows[0];
      if (!row?.version) throw new HttpError("CONFLICT");
      return read(client, tenantId, unitId, row.version);
    },
  );
}
export async function readUsageRules(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  unitId: string,
  version: number | null = null,
) {
  if (
    version !== null &&
    (!Number.isInteger(version) || version < 1 || version > 2147483647)
  )
    throw new HttpError("INVALID_INPUT");
  return command(
    pool,
    { accountId: actor.accountId, tenantId },
    async (client) => {
      await requirePermission(client, actor, "CATALOG_MANAGE", unitId);
      return read(client, tenantId, unitId, version);
    },
  );
}
export async function publicUsageRules(
  pool: Pool,
  tenantId: string,
  unitId: string,
) {
  const row = (
    await pool.query<{ version: number; text_content: string }>(
      "SELECT * FROM domain.public_unit_usage_rules($1,$2)",
      [tenantId, unitId],
    )
  ).rows[0];
  if (!row) throw new HttpError("NOT_FOUND");
  return { tenantId, unitId, version: row.version, text: row.text_content };
}
