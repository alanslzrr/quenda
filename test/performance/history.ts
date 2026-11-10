import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeOperator } from "../../scripts/lib/initialize-operator.ts";
import { transaction } from "../../src/database/transaction.ts";
import {
  createFacility,
  createReservableUnit,
} from "../../src/modules/catalog/drafts.ts";
import {
  acceptAdministratorInvitation,
  createMunicipality,
} from "../../src/modules/identity/municipality.ts";
import { listMunicipalReservations } from "../../src/modules/reservations/queries.ts";
import { withDatabase } from "../helpers/postgres.ts";
import { seedUsageRules } from "../helpers/usage-rules-fixture.ts";

const actor = {
  accountId: "history-staff",
  email: "history@example.test",
  sessionId: "fixture",
  mfaVerifiedAt: new Date(),
};
const samples: Record<string, number[]> = {};
async function measure(name: string, run: () => Promise<unknown>) {
  await run(); // Warm planning and shared buffers; report repeatable warm reads.
  const values = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    await run();
    values.push(Number((performance.now() - start).toFixed(2)));
  }
  samples[name] = values;
  process.stdout.write(`${name}: ${JSON.stringify(values)} ms\n`);
}
await withDatabase(async ({ auth, domain, migration }) => {
  await auth.query(
    'INSERT INTO auth."user"(id,name,email,"emailVerified","twoFactorEnabled") VALUES($1,$1,$2,true,true)',
    [actor.accountId, actor.email],
  );
  const connection = await migration.connect();
  try {
    await initializeOperator(connection, actor.accountId);
  } finally {
    connection.release();
  }
  const municipality = await createMunicipality(domain, actor, {
    name: "History benchmark",
    timezone: "UTC",
    administratorId: actor.accountId,
    invitationExpiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  const tenant = municipality.tenantId;
  await acceptAdministratorInvitation(
    domain,
    actor,
    tenant,
    municipality.invitationId,
  );
  const facility = await createFacility(domain, actor, tenant, {
    name: "History facility",
  });
  const unit = await createReservableUnit(
    domain,
    actor,
    tenant,
    facility.facilityId,
    { name: "History court" },
  );
  await migration.query(
    "INSERT INTO domain.unit_calendar_version(tenant_id,unit_id,version,minimum_minutes,maximum_minutes,step_minutes,weekly,exceptions,actor_id,reason) VALUES($1,$2,1,30,60,30,'[]','[]',$3,'Synthetic historical fixture')",
    [tenant, unit.unitId, actor.accountId],
  );
  await seedUsageRules(migration, tenant, unit.unitId, actor.accountId);
  // Synthetic cancelled history needs no live occupancy. Constraints and audit
  // coherence remain enabled; construction is separate from measured queries.
  for (let offset = 0; offset < 50000; offset += 1000) {
    await transaction(migration, async (c) => {
      await c.query(
        `INSERT INTO domain.reservation(tenant_id,id,account_id,unit_id,calendar_version,starts_at,ends_at,status,cancellation_minutes,timezone,created_at)
        SELECT $1,gen_random_uuid(),$2,$3,1,'2010-01-01'::timestamptz+n*interval '30 minutes','2010-01-01'::timestamptz+(n+1)*interval '30 minutes','CANCELADA',0,'UTC','2009-01-01'::timestamptz FROM generate_series($4::integer,$4::integer+999) n`,
        [tenant, actor.accountId, unit.unitId, offset],
      );
      await c.query(
        `INSERT INTO domain.reservation_event(tenant_id,id,reservation_id,revision,kind,actor_id,correlation_id,after_state,occurred_at)
        SELECT tenant_id,gen_random_uuid(),id,1,'CANCELADA',account_id,gen_random_uuid(),domain.reservation_snapshot(r),ends_at FROM domain.reservation r
        WHERE tenant_id=$1 AND starts_at>='2010-01-01'::timestamptz+$2::integer*interval '30 minutes' AND starts_at<'2010-01-01'::timestamptz+($2::integer+1000)*interval '30 minutes'`,
        [tenant, offset],
      );
    });
  }
  await migration.query(
    "ANALYZE domain.reservation; ANALYZE domain.reservation_event",
  );
  const totals = (
    await migration.query(
      "SELECT (SELECT count(*)::int FROM domain.reservation) reservations,(SELECT count(*)::int FROM domain.reservation_event) events",
    )
  ).rows[0];
  assert.deepEqual(totals, { reservations: 50000, events: 50000 });
  const page = await listMunicipalReservations(domain, actor, tenant);
  await measure("agenda-first-page", async () =>
    assert.equal(
      (await listMunicipalReservations(domain, actor, tenant)).items.length,
      20,
    ),
  );
  await measure("agenda-next-page", async () =>
    assert.equal(
      (
        await listMunicipalReservations(domain, actor, tenant, {
          after: page.nextCursor,
        })
      ).items.length,
      20,
    ),
  );
  await measure("agenda-last-day", async () =>
    assert.equal(
      (
        await listMunicipalReservations(domain, actor, tenant, {
          date: "2012-11-07",
        })
      ).items.length,
      20,
    ),
  );
  await measure("retention-candidates", async () =>
    assert.equal(
      (
        await migration.query(
          "SELECT * FROM domain.retention_booking_candidates($1,'RESERVATIONS',now()-interval '30 days',100)",
          [tenant],
        )
      ).rowCount,
      100,
    ),
  );
  const output = join(tmpdir(), `quenda-history-${randomUUID()}.json`);
  const report = {
    revision: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    dirty: Boolean(
      execFileSync("git", ["status", "--porcelain"], {
        encoding: "utf8",
      }).trim(),
    ),
    totals,
    samples,
    generatedAt: new Date().toISOString(),
  };
  await writeFile(output, JSON.stringify(report, null, 2));
  process.stdout.write(`${output}\n`);
});
