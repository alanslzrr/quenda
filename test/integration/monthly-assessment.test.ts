import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { transaction } from "../../src/database/transaction.ts";
import {
  assessPersistedMonthlyAggregate,
  prepareMonthlyAssessment,
} from "../../src/modules/collaboration/monthly-assessment.ts";
import { withDatabase } from "../helpers/postgres.ts";

test("worker monthly assessment scopes attributed bookings without quota or public identifier access", {
  timeout: 60000,
}, async () => {
  await withDatabase(async ({ migration, auth, worker, domain }) => {
    await auth.query(
      `INSERT INTO auth."user"(id,name,email,"emailVerified","createdAt","updatedAt") SELECT 'report-'||n,'Synthetic','report-'||n||'@example.test',true,now(),now() FROM generate_series(0,9) n`,
    );
    const agreement = randomUUID(),
      tenants = [randomUUID(), randomUUID()],
      units = [randomUUID(), randomUUID()];
    await transaction(migration, async (c) => {
      for (let i = 0; i < 2; i++) {
        const facility = randomUUID();
        await c.query(
          "INSERT INTO domain.municipality(id,name,timezone) VALUES($1,'Synthetic','Europe/Madrid')",
          [tenants[i]],
        );
        await c.query(
          "INSERT INTO domain.facility(tenant_id,id,name) VALUES($1,$2,'Synthetic')",
          [tenants[i], facility],
        );
        await c.query(
          "INSERT INTO domain.reservable_unit(tenant_id,id,facility_id,name) VALUES($1,$2,$3,'Unit')",
          [tenants[i], units[i], facility],
        );
        await c.query(
          `INSERT INTO domain.unit_calendar_version(tenant_id,unit_id,version,minimum_minutes,maximum_minutes,step_minutes,weekly,exceptions,actor_id,reason) VALUES($1,$2,1,30,60,30,'[{"day":1,"startMinute":0,"endMinute":1440}]','[]','report-0','Fixture')`,
          [tenants[i], units[i]],
        );
        await c.query(
          "INSERT INTO domain.municipal_profile(tenant_id,account_id) SELECT $1,'report-'||n FROM generate_series(0,9) n",
          [tenants[i]],
        );
      }
      await c.query(
        "INSERT INTO domain.agreement(id,name,timezone,created_by,created_by_tenant) VALUES($1,'Monthly','Europe/Madrid','report-0',$2)",
        [agreement, tenants[0]],
      );
      await c.query(
        "INSERT INTO domain.agreement_version(agreement_id,version,status,starts_at,ends_at,purpose,legal_basis,responsibilities,retention_policy,eligibility,weekly_limit,aggregate_reports,created_by,correlation_id) VALUES($1,1,'ACTIVADO','2024-02-29T23:00:00Z','2024-03-31T22:00:00Z','Purpose','Basis','Responsibility','Policy','acceso_abierto',NULL,true,'report-0',$2)",
        [agreement, randomUUID()],
      );
      await c.query(
        "INSERT INTO domain.agreement_activation(agreement_id,version,effective_period,activated_by,correlation_id) VALUES($1,1,'[2024-02-29T23:00:00Z,2024-03-31T22:00:00Z)','report-0',$2)",
        [agreement, randomUUID()],
      );
      await c.query(
        "INSERT INTO domain.agreement_subject(agreement_id,id,account_id) SELECT $1,gen_random_uuid(),'report-'||n FROM generate_series(0,9) n",
        [agreement],
      );
      for (let i = 0; i < 2; i++) {
        await c.query(
          "INSERT INTO domain.agreement_participant VALUES($1,1,$2,false)",
          [agreement, tenants[i]],
        );
        await c.query("INSERT INTO domain.agreement_unit VALUES($1,1,$2,$3)", [
          agreement,
          tenants[i],
          units[i],
        ]);
        await c.query(
          "INSERT INTO domain.agreement_assignment VALUES($1,1,$2,$3,'[2024-02-29T23:00:00Z,2024-03-31T22:00:00Z)')",
          [agreement, tenants[i], units[i]],
        );
        await c.query(
          "WITH bookings AS (INSERT INTO domain.reservation(tenant_id,id,account_id,unit_id,calendar_version,starts_at,ends_at,cancellation_minutes,timezone) SELECT $1,gen_random_uuid(),'report-'||n,$2,1,timestamptz '2024-03-10T00:00:00Z'+n*interval '1 hour',timestamptz '2024-03-10T01:00:00Z'+n*interval '1 hour',60,'Europe/Madrid' FROM generate_series(0,9) n RETURNING *) INSERT INTO domain.occupancy(tenant_id,id,unit_id,reservation_id,period) SELECT tenant_id,gen_random_uuid(),unit_id,id,tstzrange(starts_at,ends_at,'[)') FROM bookings",
          [tenants[i], units[i]],
        );
        await c.query(
          "INSERT INTO domain.agreement_consumption(agreement_id,tenant_id,reservation_id,subject_id,attribution_version,unit_id,starts_at,ends_at,week_start) SELECT $1,r.tenant_id,r.id,s.id,1,r.unit_id,r.starts_at,r.ends_at,date_trunc('week',r.starts_at AT TIME ZONE 'Europe/Madrid')::date FROM domain.reservation r JOIN domain.agreement_subject s ON s.agreement_id=$1 AND s.account_id=r.account_id WHERE r.tenant_id=$2",
          [agreement, tenants[i]],
        );
      }
    });
    const result = await assessPersistedMonthlyAggregate(
      worker,
      agreement,
      "2024-03",
    );
    assert.deepEqual(result.assessment, {
      status: "THRESHOLD_MET",
      reservations: 20,
      reservedMinutes: 1200,
    });
    assert.ok(!JSON.stringify(result).includes("report-"));
    assert.ok(tenants.every((t) => !JSON.stringify(result).includes(t)));
    const first = await prepareMonthlyAssessment(
      worker,
      agreement,
      "2024-03",
      0,
    );
    assert.equal(first.revision, 1);
    assert.deepEqual(first.assessment, result.assessment);
    const corrections = await Promise.allSettled([
      prepareMonthlyAssessment(worker, agreement, "2024-03", 1),
      prepareMonthlyAssessment(worker, agreement, "2024-03", 1),
    ]);
    assert.equal(corrections.filter((r) => r.status === "fulfilled").length, 1);
    const loser = corrections.find((r) => r.status === "rejected");
    assert.ok(loser && loser.status === "rejected");
    assert.equal(loser.reason.code, "CONFLICT");
    const saved = (
      await migration.query(
        "SELECT revision,status,reservations,reserved_minutes,source_digest,control_version,participants,cutoff,created_at FROM domain.monthly_assessment WHERE agreement_id=$1 ORDER BY revision",
        [agreement],
      )
    ).rows;
    assert.deepEqual(
      saved.map((r) => r.revision),
      [1, 2],
    );
    assert.ok(
      saved.every(
        (r) =>
          r.status === "THRESHOLD_MET" &&
          r.reservations === 20 &&
          r.reserved_minutes === 1200 &&
          r.control_version === 1,
      ),
    );
    assert.ok(
      saved.every(
        (r) =>
          /^[0-9a-f]{64}$/.test(r.source_digest) && r.cutoff <= r.created_at,
      ),
    );
    assert.deepEqual([...saved[0].participants].sort(), [...tenants].sort());
    await assert.rejects(
      worker.query("SELECT * FROM domain.monthly_assessment"),
      { code: "42501" },
    );
    await assert.rejects(
      domain.query("SELECT * FROM domain.monthly_assessment"),
      { code: "42501" },
    );
    await assert.rejects(
      prepareMonthlyAssessment(domain, agreement, "2024-03", 2),
      { code: "FORBIDDEN" },
    );
    await assert.rejects(
      migration.query(
        "UPDATE domain.monthly_assessment SET reservations=0 WHERE agreement_id=$1",
        [agreement],
      ),
      { code: "23514" },
    );
    await assert.rejects(
      migration.query(
        "DELETE FROM domain.monthly_assessment WHERE agreement_id=$1",
        [agreement],
      ),
      { code: "23514" },
    );
    await assert.rejects(
      assessPersistedMonthlyAggregate(domain, agreement, "2024-03"),
      { code: "FORBIDDEN" },
    );
    await assert.rejects(
      worker.query("SELECT * FROM domain.agreement_consumption"),
      { code: "42501" },
    );
    await assert.rejects(
      assessPersistedMonthlyAggregate(worker, agreement, "2999-01"),
      { code: "INVALID_INPUT" },
    );
    await assert.rejects(
      assessPersistedMonthlyAggregate(worker, randomUUID(), "2024-03"),
      { code: "NOT_FOUND" },
    );
    await migration.query(
      "UPDATE domain.agreement_consumption SET released=true WHERE agreement_id=$1 AND tenant_id=$2 AND reservation_id=(SELECT min(reservation_id::text)::uuid FROM domain.agreement_consumption WHERE agreement_id=$1 AND tenant_id=$2)",
      [agreement, tenants[1]],
    );
    assert.deepEqual(
      (await assessPersistedMonthlyAggregate(worker, agreement, "2024-03"))
        .assessment,
      { status: "NOT_PUBLISHABLE" },
    );
    const suppressed = await prepareMonthlyAssessment(
      worker,
      agreement,
      "2024-03",
      2,
    );
    assert.equal(suppressed.revision, 3);
    assert.deepEqual(suppressed.assessment, { status: "NOT_PUBLISHABLE" });
    assert.deepEqual(
      (
        await migration.query(
          "SELECT status,reservations,reserved_minutes FROM domain.monthly_assessment WHERE agreement_id=$1 AND revision=3",
          [agreement],
        )
      ).rows[0],
      { status: "NOT_PUBLISHABLE", reservations: null, reserved_minutes: null },
    );
    assert.equal(
      (
        await migration.query(
          "SELECT reservations FROM domain.monthly_assessment WHERE agreement_id=$1 AND revision=1",
          [agreement],
        )
      ).rows[0].reservations,
      20,
    );
    await migration.query(
      "UPDATE domain.agreement_consumption SET released=false WHERE agreement_id=$1",
      [agreement],
    );
    await migration.query(
      "UPDATE domain.agreement_activation SET effective_period='[2024-02-29T23:00:00Z,2024-03-10T09:30:00Z)' WHERE agreement_id=$1",
      [agreement],
    );
    assert.deepEqual(
      (await assessPersistedMonthlyAggregate(worker, agreement, "2024-03"))
        .assessment,
      { status: "THRESHOLD_MET", reservations: 20, reservedMinutes: 1140 },
    );
    await migration.query(
      "UPDATE domain.agreement_version SET aggregate_reports=false WHERE agreement_id=$1",
      [agreement],
    );
    assert.deepEqual(
      (await assessPersistedMonthlyAggregate(worker, agreement, "2024-03"))
        .assessment,
      { status: "NOT_PUBLISHABLE" },
    );
  });
});
