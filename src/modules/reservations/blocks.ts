import { randomUUID } from "node:crypto";
import { DatabaseError, type Pool, type PoolClient } from "pg";
import { idempotentCommand } from "../../database/idempotency.ts";
import { HttpError } from "../../http/errors.ts";
import {
  type AuthenticatedAccount,
  requirePermission,
} from "../identity/index.ts";
import {
  type CreateReservationInput,
  normalizeReservationInput,
} from "./input.ts";

interface Block {
  id: string;
  tenant_id: string;
  unit_id: string;
  starts_at: Date;
  ends_at: Date;
  reason: string;
  released_at: Date | null;
}
const present = (b: Block) => ({
  id: b.id,
  tenantId: b.tenant_id,
  unitId: b.unit_id,
  startsAt: b.starts_at.toISOString(),
  endsAt: b.ends_at.toISOString(),
  reason: b.reason,
  releasedAt: b.released_at?.toISOString() ?? null,
});
function motive(value: string) {
  const reason = value.trim();
  if (!reason || reason.length > 500) throw new HttpError("INVALID_INPUT");
  return reason;
}
async function event(
  client: PoolClient,
  tenantId: string,
  blockId: string,
  actor: AuthenticatedAccount,
  operation: "CREATE" | "RELEASE",
  reason: string,
  correlationId: string,
) {
  await client.query(
    "INSERT INTO domain.block_event(tenant_id,id,block_id,actor_id,operation,reason,correlation_id) VALUES($1,$2,$3,$4,$5,$6,$7)",
    [
      tenantId,
      randomUUID(),
      blockId,
      actor.accountId,
      operation,
      reason,
      correlationId,
    ],
  );
}
function failure(error: unknown): never {
  if (error instanceof DatabaseError) {
    if (["23P01", "40001", "40P01"].includes(error.code ?? ""))
      throw new HttpError("CONFLICT");
    if (error.code === "23503") throw new HttpError("NOT_FOUND");
  }
  throw error;
}
export async function createBlock(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  key: string,
  input: CreateReservationInput & { reason: string },
  correlationId: string,
  retentionSeconds: number,
) {
  const normalized = normalizeReservationInput(input),
    reason = motive(input.reason);
  try {
    return await idempotentCommand(
      pool,
      { accountId: actor.accountId, tenantId },
      {
        operation: "block.create",
        key,
        input: { ...normalized, reason },
        retentionSeconds,
        authorize: async (client) => {
          await requirePermission(
            client,
            actor,
            "UNIT_BLOCK",
            normalized.unitId,
          );
        },
        execute: async (client) => {
          const id = randomUUID();
          const saved = await client.query<Block>(
            "INSERT INTO domain.schedule_block(tenant_id,id,unit_id,starts_at,ends_at,actor_id,reason) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
            [
              tenantId,
              id,
              normalized.unitId,
              normalized.startsAt,
              normalized.endsAt,
              actor.accountId,
              reason,
            ],
          );
          await client.query(
            "INSERT INTO domain.occupancy(tenant_id,id,unit_id,block_id,period) VALUES($1,$2,$3,$4,tstzrange($5,$6,'[)'))",
            [
              tenantId,
              randomUUID(),
              normalized.unitId,
              id,
              normalized.startsAt,
              normalized.endsAt,
            ],
          );
          await event(
            client,
            tenantId,
            id,
            actor,
            "CREATE",
            reason,
            correlationId,
          );
          return present(saved.rows[0] as Block);
        },
      },
    );
  } catch (error) {
    failure(error);
  }
}
export async function releaseBlock(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  blockId: string,
  key: string,
  input: { reason: string },
  correlationId: string,
  retentionSeconds: number,
) {
  const reason = motive(input.reason);
  try {
    return await idempotentCommand(
      pool,
      { accountId: actor.accountId, tenantId },
      {
        operation: "block.release",
        key,
        input: { blockId, reason },
        retentionSeconds,
        authorize: async (client) => {
          const found = await client.query<Block>(
            "SELECT * FROM domain.schedule_block WHERE tenant_id=$1 AND id=$2",
            [tenantId, blockId],
          );
          if (!found.rows[0]) throw new HttpError("NOT_FOUND");
          await requirePermission(
            client,
            actor,
            "UNIT_BLOCK",
            found.rows[0].unit_id,
          );
        },
        execute: async (client) => {
          const found = await client.query<Block>(
            "SELECT * FROM domain.schedule_block WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
            [tenantId, blockId],
          );
          const block = found.rows[0];
          if (!block) throw new HttpError("NOT_FOUND");
          if (block.released_at) return present(block);
          const saved = await client.query<Block>(
            "UPDATE domain.schedule_block SET released_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 RETURNING *",
            [tenantId, blockId],
          );
          await client.query(
            "UPDATE domain.occupancy SET released_at=clock_timestamp() WHERE tenant_id=$1 AND block_id=$2 AND released_at IS NULL",
            [tenantId, blockId],
          );
          await event(
            client,
            tenantId,
            blockId,
            actor,
            "RELEASE",
            reason,
            correlationId,
          );
          return present(saved.rows[0] as Block);
        },
      },
    );
  } catch (error) {
    failure(error);
  }
}
