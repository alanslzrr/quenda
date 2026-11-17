import { randomUUID } from "node:crypto";
import { DatabaseError, type Pool } from "pg";
import { defaultIdempotencyRetentionSeconds } from "../../config.ts";
import { idempotentCommand } from "../../database/idempotency.ts";
import { HttpError } from "../../http/errors.ts";
import {
  type AuthenticatedAccount,
  requirePermission,
} from "../identity/index.ts";

function name(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 200)
    throw new HttpError("INVALID_INPUT");
  return normalized;
}

export async function createFacility(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  input: { name: string },
  key: string = randomUUID(),
  retentionSeconds = defaultIdempotencyRetentionSeconds,
) {
  const title = name(input.name);
  const facilityId = randomUUID();
  return idempotentCommand(
    pool,
    { accountId: actor.accountId, tenantId },
    {
      operation: "catalog.create-facility",
      key,
      retentionSeconds,
      input: { name: title },
      authorize: (client) => requirePermission(client, actor, "CATALOG_CREATE"),
      execute: async (client) => {
        await client.query(
          "INSERT INTO domain.facility (tenant_id,id,name) VALUES ($1,$2,$3)",
          [tenantId, facilityId, title],
        );
        await client.query(
          "INSERT INTO domain.catalog_event (tenant_id,id,actor_id,facility_id,operation) VALUES ($1,$2,$3,$4,'CREATE_FACILITY')",
          [tenantId, randomUUID(), actor.accountId, facilityId],
        );
        return { tenantId, facilityId, name: title };
      },
    },
  ).then(({ result }) => result);
}

export async function createReservableUnit(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  facilityId: string,
  input: { name: string },
  key: string = randomUUID(),
  retentionSeconds = defaultIdempotencyRetentionSeconds,
) {
  const title = name(input.name);
  const unitId = randomUUID();
  try {
    return await idempotentCommand(
      pool,
      { accountId: actor.accountId, tenantId },
      {
        operation: "catalog.create-unit",
        key,
        retentionSeconds,
        input: { facilityId, name: title },
        authorize: (client) =>
          requirePermission(client, actor, "CATALOG_CREATE"),
        execute: async (client) => {
          const parent = await client.query<{ withdrawn_at: Date | null }>(
            "SELECT withdrawn_at FROM domain.lock_catalog_parent($1)",
            [facilityId],
          );
          if (!parent.rows[0]) throw new HttpError("NOT_FOUND");
          if (parent.rows[0].withdrawn_at)
            throw new HttpError("FACILITY_WITHDRAWN");
          await client.query(
            "INSERT INTO domain.reservable_unit (tenant_id,id,facility_id,name) VALUES ($1,$2,$3,$4)",
            [tenantId, unitId, facilityId, title],
          );
          await client.query(
            "INSERT INTO domain.catalog_event (tenant_id,id,actor_id,facility_id,unit_id,operation) VALUES ($1,$2,$3,$4,$5,'CREATE_UNIT')",
            [tenantId, randomUUID(), actor.accountId, facilityId, unitId],
          );
          return { tenantId, facilityId, unitId, name: title };
        },
      },
    ).then(({ result }) => result);
  } catch (error) {
    if (error instanceof DatabaseError && error.code === "23503")
      throw new HttpError("NOT_FOUND");
    throw error;
  }
}
