import { randomUUID } from "node:crypto";
import { DatabaseError, type Pool } from "pg";
import { command } from "../../database/command.ts";
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
) {
  const title = name(input.name);
  const facilityId = randomUUID();
  return command(
    pool,
    { accountId: actor.accountId, tenantId },
    async (client) => {
      await requirePermission(client, actor, "CATALOG_CREATE");
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
  );
}

export async function createReservableUnit(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  facilityId: string,
  input: { name: string },
) {
  const title = name(input.name);
  const unitId = randomUUID();
  try {
    return await command(
      pool,
      { accountId: actor.accountId, tenantId },
      async (client) => {
        await requirePermission(client, actor, "CATALOG_CREATE");
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
    );
  } catch (error) {
    if (error instanceof DatabaseError && error.code === "23503")
      throw new HttpError("NOT_FOUND");
    throw error;
  }
}
