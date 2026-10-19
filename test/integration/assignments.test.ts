import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { transaction } from "../../src/database/transaction.ts";
import { withDatabase } from "../helpers/postgres.ts";

test("effective agreement assignments exclude overlap and retain the closed-access gate", {
  timeout: 60000,
}, async (t) => {
  await withDatabase(async ({ domain, auth, migration }) => {
    await auth.query(
      'INSERT INTO auth."user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES(\'admin\',\'Admin\',\'admin@example.test\',true,now(),now())',
    );
    const tenant = randomUUID(),
      facility = randomUUID(),
      unit = randomUUID(),
      a = randomUUID(),
      b = randomUUID();
    await migration.query(
      "INSERT INTO domain.municipality(id,name,timezone) VALUES($1,'Synthetic','Europe/Madrid')",
      [tenant],
    );
    await migration.query(
      "INSERT INTO domain.facility(tenant_id,id,name) VALUES($1,$2,'Facility')",
      [tenant, facility],
    );
    await migration.query(
      "INSERT INTO domain.reservable_unit(tenant_id,id,facility_id,name) VALUES($1,$2,$3,'Unit')",
      [tenant, unit, facility],
    );
    for (const id of [a, b])
      await transaction(migration, async (c) => {
        await c.query(
          "INSERT INTO domain.agreement(id,name,timezone,created_by,created_by_tenant) VALUES($1,'Agreement','Europe/Madrid','admin',$2)",
          [id, tenant],
        );
        for (const version of [1, 2]) {
          await c.query(
            "INSERT INTO domain.agreement_version(agreement_id,version,starts_at,ends_at,purpose,legal_basis,responsibilities,retention_policy,eligibility,aggregate_reports,created_by,correlation_id) VALUES($1,$2,'2030-01-01T00:00:00Z','2031-01-01T00:00:00Z','Purpose','Reference','Municipal','Policy','acceso_abierto',false,'admin',$3)",
            [id, version, randomUUID()],
          );
          await c.query(
            "INSERT INTO domain.agreement_participant VALUES($1,$2,$3,false)",
            [id, version, tenant],
          );
          await c.query(
            "INSERT INTO domain.agreement_unit VALUES($1,$2,$3,$4)",
            [id, version, tenant, unit],
          );
        }
        await c.query(
          "UPDATE domain.agreement SET latest_version=2 WHERE id=$1",
          [id],
        );
      });
    const insert =
      "INSERT INTO domain.agreement_activation(agreement_id,version,effective_period,activated_by,correlation_id) VALUES($1,$2,$3::tstzrange,'admin',$4)";
    const period = "[2030-01-01T00:00:00Z,2030-07-01T00:00:00Z)";
    await t.test(
      "one effective version per agreement and finite approved intervals",
      async () => {
        for (const invalid of [
          "empty",
          "(,2030-02-01)",
          "[2029-12-31,2030-02-01)",
          "[2030-01-01,2031-02-01)",
          "(2030-01-01,2030-02-01]",
        ])
          await assert.rejects(
            migration.query(insert, [a, 1, invalid, randomUUID()]),
            { code: "23514" },
          );
        await migration.query(insert, [a, 1, period, randomUUID()]);
        await assert.rejects(
          migration.query(insert, [a, 2, period, randomUUID()]),
          { code: "23P01" },
        );
        await migration.query(insert, [
          a,
          2,
          "[2030-07-01T00:00:00Z,2031-01-01T00:00:00Z)",
          randomUUID(),
        ]);
        await migration.query(insert, [b, 1, period, randomUUID()]);
      },
    );
    await t.test(
      "one agreement per unit and exact activation interval",
      async () => {
        const assign =
          "INSERT INTO domain.agreement_assignment VALUES($1,$2,$3,$4,$5::tstzrange)";
        await assert.rejects(
          migration.query(assign, [
            a,
            1,
            tenant,
            unit,
            "[2030-02-01,2030-03-01)",
          ]),
          { code: "23503" },
        );
        await migration.query(assign, [a, 1, tenant, unit, period]);
        await assert.rejects(
          migration.query(assign, [b, 1, tenant, unit, period]),
          { code: "23P01" },
        );
        await migration.query(assign, [
          a,
          2,
          tenant,
          unit,
          "[2030-07-01T00:00:00Z,2031-01-01T00:00:00Z)",
        ]);
        await migration.query(
          "INSERT INTO domain.unit_agreement_gate VALUES($1,$2,$3,1)",
          [tenant, unit, a],
        );
        await migration.query(
          "UPDATE domain.agreement_activation SET effective_period=tstzrange(lower(effective_period),'2030-06-01T00:00:00Z','[)') WHERE agreement_id=$1 AND version=1",
          [a],
        );
        assert.equal(
          (
            await migration.query(
              "SELECT upper(effective_period) AS ending FROM domain.agreement_assignment WHERE agreement_id=$1 AND version=1",
              [a],
            )
          ).rows[0].ending.toISOString(),
          "2030-06-01T00:00:00.000Z",
        );
        await migration.query(
          "UPDATE domain.agreement_version SET status='SUSPENDIDO' WHERE agreement_id=$1 AND version=1",
          [a],
        );
        assert.equal(
          (
            await migration.query(
              "SELECT count(*)::int AS n FROM domain.unit_agreement_gate",
            )
          ).rows[0].n,
          1,
        );
        for (const table of [
          "agreement_activation",
          "agreement_assignment",
          "unit_agreement_gate",
        ]) {
          await assert.rejects(domain.query(`SELECT * FROM domain.${table}`), {
            code: "42501",
          });
          await assert.rejects(domain.query(`DELETE FROM domain.${table}`), {
            code: "42501",
          });
        }
      },
    );
    await t.test(
      "competing assignments leave one winner; closing a scheduled version preserves its gate",
      async () => {
        const outcomes = await Promise.allSettled([
          migration.query(
            "UPDATE domain.agreement_activation SET effective_period=tstzrange('2030-06-01T00:00:00Z',upper(effective_period),'[)') WHERE agreement_id=$1 AND version=2",
            [a],
          ),
          transaction(migration, async (c) => {
            const span = "[2030-06-01T00:00:00Z,2030-07-01T00:00:00Z)";
            await c.query(insert, [b, 2, span, randomUUID()]);
            await c.query(
              "INSERT INTO domain.agreement_assignment VALUES($1,2,$2,$3,$4::tstzrange)",
              [b, tenant, unit, span],
            );
          }),
        ]);
        assert.equal(
          outcomes.filter((o) => o.status === "fulfilled").length,
          1,
        );
        for (const o of outcomes)
          if (o.status === "rejected")
            assert.ok(["23P01", "40001", "40P01"].includes(o.reason.code));
        assert.equal(
          (
            await migration.query(
              "SELECT count(*)::int AS n FROM domain.agreement_assignment WHERE effective_period @> '2030-06-15T00:00:00Z'::timestamptz",
            )
          ).rows[0].n,
          1,
        );
        await migration.query(
          "UPDATE domain.unit_agreement_gate SET version=2 WHERE tenant_id=$1 AND unit_id=$2",
          [tenant, unit],
        );
        await migration.query(
          "UPDATE domain.agreement_activation SET effective_period='empty' WHERE agreement_id=$1 AND version=2",
          [a],
        );
        assert.equal(
          (
            await migration.query(
              "SELECT isempty(effective_period) AS empty FROM domain.agreement_assignment WHERE agreement_id=$1 AND version=2",
              [a],
            )
          ).rows[0].empty,
          true,
        );
        assert.equal(
          (
            await migration.query(
              "SELECT count(*)::int AS n FROM domain.unit_agreement_gate",
            )
          ).rows[0].n,
          1,
        );
      },
    );
  });
});
