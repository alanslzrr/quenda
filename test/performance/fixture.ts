import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { createReservation } from "../../src/modules/reservations/index.ts";
import {
  initialAcceptance,
  seedUsageRules,
} from "../helpers/usage-rules-fixture.ts";

export async function performanceFixture(
  pools: { migration: Pool; domain: Pool },
  accounts: string[],
) {
  assert.equal(accounts.length, 10);
  const units: { tenantId: string; unitId: string }[] = [];
  for (let municipality = 0; municipality < 3; municipality++) {
    const tenant = randomUUID(),
      facility = randomUUID();
    await pools.migration.query(
      "INSERT INTO domain.municipality(id,name,timezone,cancellation_minutes) VALUES($1,'Performance fixture','UTC',0)",
      [tenant],
    );
    await pools.migration.query(
      "INSERT INTO domain.facility(tenant_id,id,name,published_at) VALUES($1,$2,'Performance facility',now())",
      [tenant, facility],
    );
    for (let n = 0; n < 10; n++) {
      const unit = randomUUID();
      await pools.migration.query(
        "INSERT INTO domain.reservable_unit(tenant_id,id,facility_id,name) VALUES($1,$2,$3,'Performance unit')",
        [tenant, unit, facility],
      );
      await pools.migration.query(
        "INSERT INTO domain.unit_calendar_version(tenant_id,unit_id,version,minimum_minutes,maximum_minutes,step_minutes,weekly,exceptions,actor_id,reason) VALUES($1,$2,1,60,60,60,$3,'[]',$4,'Synthetic performance dataset')",
        [
          tenant,
          unit,
          JSON.stringify(
            Array.from({ length: 7 }, (_, i) => ({
              day: i + 1,
              startMinute: 0,
              endMinute: 1440,
            })),
          ),
          accounts[0],
        ],
      );
      await seedUsageRules(
        pools.migration,
        tenant,
        unit,
        accounts[0] as string,
      );
      await pools.migration.query(
        "UPDATE domain.reservable_unit SET calendar_version=1,published_at=now() WHERE tenant_id=$1 AND id=$2",
        [tenant, unit],
      );
      units.push({ tenantId: tenant, unitId: unit });
    }
  }
  const base = new Date();
  base.setUTCDate(base.getUTCDate() - 101);
  base.setUTCHours(10, 0, 0, 0);
  // Synthetic history is built through the real transactional booking service,
  // with its supported clock seam; no constraints, RLS or triggers are disabled.
  for (let i = 0; i < 3000; i++) {
    const unit = units[i % 30],
      account = accounts[i % 10];
    assert.ok(unit && account);
    const start = new Date(base.getTime() + Math.floor(i / 30) * 86400000);
    await createReservation(
      pools.domain,
      {
        accountId: account,
        email: `load-${i % 10}@example.test`,
        sessionId: "performance-fixture",
        mfaVerifiedAt: null,
      },
      unit.tenantId,
      `historical-${i}`,
      {
        acceptance: initialAcceptance,
        unitId: unit.unitId,
        startsAt: start.toISOString(),
        endsAt: new Date(start.getTime() + 3600000).toISOString(),
      },
      randomUUID(),
      3600,
      { now: () => new Date(start.getTime() - 86400000) },
    );
  }
  const totals = (
    await pools.migration.query(
      "SELECT (SELECT count(*)::int FROM domain.municipality) AS municipalities,(SELECT count(*)::int FROM domain.reservable_unit) AS units,(SELECT count(*)::int FROM domain.reservation WHERE ends_at<now()) AS historical",
    )
  ).rows[0];
  assert.deepEqual(totals, { municipalities: 3, units: 30, historical: 3000 });
  return { units, totals };
}
