import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "pg";
import { migrate } from "../../scripts/lib/migrations.ts";
import { reconcileRestore } from "../../scripts/lib/reconcile.ts";
import { readReservation } from "../../src/modules/reservations/index.ts";
import { withDatabase } from "../helpers/postgres.ts";
import { seedUsageRules } from "../helpers/usage-rules-fixture.ts";

test("0066 upgrades a populated 0065 database without rewriting historical evidence or booking effects", {
  timeout: 60000,
}, async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "quenda-relocation-upgrade-"),
  );
  await cp(path.resolve("db/migrations"), directory, { recursive: true });
  for (const name of await readdir(directory))
    if (name.endsWith(".sql") && name >= "0066_")
      await rm(path.join(directory, name));
  try {
    await withDatabase(async ({ auth, migration, domain, administration }) => {
      const tenant = randomUUID(),
        facility = randomUUID(),
        unit = randomUUID(),
        recorded = randomUUID(),
        historical = randomUUID();
      const actor = {
        accountId: "upgrade-holder",
        email: "upgrade-holder@example.test",
        sessionId: "upgrade-fixture",
        mfaVerifiedAt: null,
      };
      await auth.query(
        'INSERT INTO auth."user"(id,name,email,"emailVerified") VALUES($1,$1,$2,true)',
        [actor.accountId, actor.email],
      );
      await migration.query(
        "INSERT INTO domain.municipality(id,name,timezone) VALUES($1,'Upgrade','Europe/Madrid')",
        [tenant],
      );
      await migration.query(
        "INSERT INTO domain.municipal_profile(tenant_id,account_id) VALUES($1,$2)",
        [tenant, actor.accountId],
      );
      await migration.query(
        "INSERT INTO domain.facility(tenant_id,id,name,published_at) VALUES($1,$2,'Facility',now())",
        [tenant, facility],
      );
      await migration.query(
        "INSERT INTO domain.reservable_unit(tenant_id,id,facility_id,name) VALUES($1,$2,$3,'Unit')",
        [tenant, unit, facility],
      );
      await migration.query(
        "INSERT INTO domain.unit_calendar_version(tenant_id,unit_id,version,minimum_minutes,maximum_minutes,step_minutes,weekly,exceptions,actor_id,reason) VALUES($1,$2,1,60,60,60,$3,'[]',$4,'Upgrade fixture')",
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
          actor.accountId,
        ],
      );
      await seedUsageRules(migration, tenant, unit, actor.accountId);
      await migration.query(
        "UPDATE domain.reservable_unit SET calendar_version=1,published_at=now() WHERE tenant_id=$1 AND id=$2",
        [tenant, unit],
      );
      const owner = new Client({
        connectionString: migration.options.connectionString,
      });
      const admin = new Client({
        connectionString: administration.options.connectionString,
      });
      await owner.connect();
      await admin.connect();
      try {
        await owner.query("SET TIME ZONE 'UTC'");
        for (const [id, legacy, day] of [
          [recorded, false, "03"],
          [historical, true, "04"],
        ] as const) {
          await owner.query("BEGIN");
          try {
            await owner.query(
              "SELECT set_config('quenda.account_id',$1,true),set_config('quenda.tenant_id',$2,true)",
              [actor.accountId, tenant],
            );
            await owner.query(
              `INSERT INTO domain.reservation(tenant_id,id,account_id,unit_id,calendar_version,
               starts_at,ends_at,cancellation_minutes,timezone,usage_rules_version,rules_accepted_at,
               booking_policy_version,conditions_accepted_at,non_cancellable_accepted)
               VALUES($1,$2,$3,$4,1,$5,$6,1440,'Europe/Madrid',
               CASE WHEN $7 THEN NULL ELSE 1 END,
               CASE WHEN $7 THEN NULL ELSE '2026-10-20T10:11:12.123456Z'::timestamptz END,
               CASE WHEN $7 THEN NULL ELSE 1 END,
               CASE WHEN $7 THEN NULL ELSE '2026-10-20T10:11:12.654321Z'::timestamptz END,
               CASE WHEN $7 THEN NULL ELSE false END)`,
              [
                tenant,
                id,
                actor.accountId,
                unit,
                `2030-04-${day}T10:00:00Z`,
                `2030-04-${day}T11:00:00Z`,
                legacy,
              ],
            );
            await owner.query(
              "INSERT INTO domain.occupancy(tenant_id,id,unit_id,reservation_id,period) SELECT tenant_id,$2,unit_id,id,tstzrange(starts_at,ends_at,'[)') FROM domain.reservation WHERE id=$1",
              [id, randomUUID()],
            );
            await owner.query(
              "SELECT domain.append_reservation_event($1,$2,$3,NULL)",
              [id, randomUUID(), randomUUID()],
            );
            await owner.query("COMMIT");
          } catch (error) {
            await owner.query("ROLLBACK");
            throw error;
          }
        }
        const previousColumns = async (upgraded: boolean) =>
          (
            await owner.query(
              `SELECT (${upgraded ? "to_jsonb(r)-ARRAY['usage_rules_unit_id','pending_usage_rules_version']" : "to_jsonb(r)"})::text AS value FROM domain.reservation r ORDER BY id`,
            )
          ).rows;
        const evidence = async () => ({
          events: (
            await owner.query(
              "SELECT to_jsonb(e)::text AS value FROM domain.reservation_event e ORDER BY id",
            )
          ).rows,
          occupancy: (
            await owner.query(
              "SELECT to_jsonb(o)::text AS value FROM domain.occupancy o ORDER BY id",
            )
          ).rows,
          notices: (
            await owner.query(
              "SELECT to_jsonb(n)::text AS value FROM domain.reservation_notice n ORDER BY event_id",
            )
          ).rows,
          email: (
            await owner.query(
              "SELECT to_jsonb(e)::text AS value FROM domain.reservation_email e ORDER BY event_id",
            )
          ).rows,
        });
        const beforeRows = await previousColumns(false);
        const beforeEvidence = await evidence();
        assert.ok(
          JSON.stringify(beforeRows).includes("2026-10-20T10:11:12.123456"),
        );
        assert.ok(
          JSON.stringify(beforeRows).includes("2026-10-20T10:11:12.654321"),
        );
        const applied = await migrate(owner, path.resolve("db/migrations"));
        assert.ok(
          applied.includes("0066_administrative_relocation_acceptance.sql"),
        );
        assert.deepEqual(await previousColumns(true), beforeRows);
        assert.deepEqual(await evidence(), beforeEvidence);
        assert.deepEqual(
          (
            await owner.query(
              "SELECT usage_rules_unit_id,pending_usage_rules_version FROM domain.reservation WHERE id=$1",
              [recorded],
            )
          ).rows[0],
          { usage_rules_unit_id: unit, pending_usage_rules_version: null },
        );
        assert.deepEqual(
          (
            await owner.query(
              "SELECT usage_rules_unit_id,pending_usage_rules_version FROM domain.reservation WHERE id=$1",
              [historical],
            )
          ).rows[0],
          { usage_rules_unit_id: null, pending_usage_rules_version: null },
        );
        for (const [id, acceptedUnit] of [
          [recorded, unit],
          [historical, null],
        ] as const) {
          const detail = await readReservation(domain, actor, tenant, id);
          assert.equal(detail.usageRulesUnitId, acceptedUnit);
          assert.equal(detail.pendingUsageRulesVersion, null);
          assert.equal(detail.pendingUsageRulesText, null);
        }
        const report = await reconcileRestore(
          admin,
          path.resolve("db/migrations"),
        );
        assert.equal(report.status, "CHECKED_REQUIRES_REVIEW");
        assert.ok(Object.values(report.checks).every((n) => n === 0));
        assert.equal(report.reopeningAuthorized, false);
        assert.deepEqual(
          await migrate(owner, path.resolve("db/migrations")),
          [],
        );
        assert.deepEqual(await evidence(), beforeEvidence);
      } finally {
        await owner.end();
        await admin.end();
      }
    }, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
