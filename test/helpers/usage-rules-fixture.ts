import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

/** Explicit synthetic rules for low-level fixtures; never invents acceptance. */
export async function seedUsageRules(
  client: Pool | PoolClient,
  tenantId: string,
  unitId: string,
  actorId: string,
) {
  await client.query(
    `INSERT INTO domain.unit_usage_rules(tenant_id,unit_id,version,text_content,actor_id,reason,correlation_id)
     VALUES($1,$2,1,'Synthetic fixture rules',$3,'Synthetic fixture',$4)`,
    [tenantId, unitId, actorId, randomUUID()],
  );
  await client.query(
    "UPDATE domain.reservable_unit SET usage_rules_version=1 WHERE tenant_id=$1 AND id=$2",
    [tenantId, unitId],
  );
}

/** Acceptance sent by synthetic users for the initial rules and booking policy. */
export const initialAcceptance = {
  usageRulesVersion: 1,
  bookingPolicyVersion: 1,
  nonCancellable: false,
} as const;
