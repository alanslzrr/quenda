import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setTransactionContext } from "../../src/database/context.ts";
import { transaction } from "../../src/database/transaction.ts";
import { withDatabase } from "../helpers/postgres.ts";

test("internal agreement consumptions preserve account, reservation and week coherence", {
  timeout: 60000,
}, async (t) => {
  await withDatabase(async ({ domain, auth, worker, migration }) => {
    for (const account of ["citizen", "other"])
      await auth.query(
        'INSERT INTO auth."user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())',
        [account, `${account}@example.test`],
      );
    const tenant = randomUUID(),
      facility = randomUUID(),
      unit = randomUUID(),
      agreement = randomUUID(),
      subject = randomUUID(),
      otherSubject = randomUUID(),
      booking = randomUUID();
    const start = "2030-03-31T22:00:00.000Z",
      end = "2030-03-31T23:00:00.000Z"; // Monday in Madrid, Sunday in UTC.
    await migration.query(
      "INSERT INTO domain.municipality(id,name,timezone) VALUES($1,'Synthetic','Europe/Madrid')",
      [tenant],
    );
    await migration.query(
      "INSERT INTO domain.municipal_profile(tenant_id,account_id) VALUES($1,'citizen')",
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
    await migration.query(
      "INSERT INTO domain.unit_calendar_version(tenant_id,unit_id,version,minimum_minutes,maximum_minutes,step_minutes,weekly,exceptions,actor_id,reason) VALUES($1,$2,1,30,120,30,'[]','[]','citizen','Fixture')",
      [tenant, unit],
    );
    await transaction(migration, async (c) => {
      await c.query(
        "INSERT INTO domain.agreement(id,name,timezone,created_by,created_by_tenant) VALUES($1,'Joint','Europe/Madrid','citizen',$2)",
        [agreement, tenant],
      );
      await c.query(
        "INSERT INTO domain.agreement_version(agreement_id,version,starts_at,ends_at,purpose,legal_basis,responsibilities,retention_policy,eligibility,aggregate_reports,created_by,correlation_id) VALUES($1,1,'2030-01-01','2031-01-01','Purpose','Reference','Municipal','Policy','acceso_abierto',false,'citizen',$2)",
        [agreement, randomUUID()],
      );
      await c.query(
        "INSERT INTO domain.agreement_participant VALUES($1,1,$2,false)",
        [agreement, tenant],
      );
      await c.query("INSERT INTO domain.agreement_unit VALUES($1,1,$2,$3)", [
        agreement,
        tenant,
        unit,
      ]);
      await c.query(
        "INSERT INTO domain.reservation(tenant_id,id,account_id,unit_id,calendar_version,starts_at,ends_at,cancellation_minutes,timezone) VALUES($1,$2,'citizen',$3,1,$4,$5,0,'Europe/Madrid')",
        [tenant, booking, unit, start, end],
      );
      await c.query(
        "INSERT INTO domain.occupancy(tenant_id,id,unit_id,reservation_id,period) VALUES($1,$2,$3,$4,tstzrange($5,$6,'[)'))",
        [tenant, randomUUID(), unit, booking, start, end],
      );
    });
    await migration.query(
      "INSERT INTO domain.agreement_subject VALUES($1,$2,'citizen'),($1,$3,'other')",
      [agreement, subject, otherSubject],
    );
    const insert =
      "INSERT INTO domain.agreement_consumption(agreement_id,tenant_id,reservation_id,subject_id,attribution_version,unit_id,starts_at,ends_at,week_start) VALUES($1,$2,$3,$4,1,$5,$6,$7,$8)";
    const values = [
      agreement,
      tenant,
      booking,
      subject,
      unit,
      start,
      end,
      "2030-04-01",
    ];
    await t.test(
      "rejects wrong subject, week and projection without partial writes",
      async () => {
        await assert.rejects(
          migration.query(
            "INSERT INTO domain.agreement_subject VALUES($1,$2,'citizen')",
            [agreement, randomUUID()],
          ),
          { code: "23505" },
        );
        for (const [index, value, code] of [
          [3, otherSubject, "23514"],
          [7, "2030-03-25", "23514"],
          [6, "2030-04-01T00:00:00Z", "23514"],
          [1, randomUUID(), "23503"],
        ] as const) {
          const bad = [...values];
          bad[index] = value;
          await assert.rejects(migration.query(insert, bad), { code });
        }
        assert.equal(
          (
            await migration.query(
              "SELECT count(*)::int AS n FROM domain.agreement_consumption",
            )
          ).rows[0].n,
          0,
        );
        await migration.query(insert, values);
        await assert.rejects(migration.query(insert, values), {
          code: "23505",
        });
      },
    );
    await t.test(
      "runtime has no direct subject mapping or consumption access",
      async () => {
        for (const pool of [domain, auth, worker])
          for (const table of [
            "agreement_subject",
            "agreement_consumption",
            "agreement_consumption_event",
            "agreement_credential",
          ]) {
            await assert.rejects(pool.query(`SELECT * FROM domain.${table}`), {
              code: "42501",
            });
            await assert.rejects(pool.query(`DELETE FROM domain.${table}`), {
              code: "42501",
            });
          }
        await assert.rejects(
          domain.query("SELECT domain.assert_agreement_consumption($1,$2)", [
            tenant,
            booking,
          ]),
          { code: "42501" },
        );
      },
    );
    await t.test(
      "internal projections and prelocks preserve scoped authority and restricted database roles",
      async () => {
        const tables = [
          "agreement_subject",
          "agreement_consumption",
          "agreement_consumption_event",
          "agreement_credential",
        ];
        const security = await migration.query(
          "SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,r.rolsuper,r.rolbypassrls FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner WHERE n.nspname='domain' AND c.relname=ANY($1::text[]) ORDER BY c.relname",
          [tables],
        );
        assert.equal(security.rowCount, tables.length);
        for (const row of security.rows) {
          assert.equal(row.relrowsecurity, true);
          assert.equal(row.relforcerowsecurity, true);
          assert.equal(row.rolsuper, false);
          assert.equal(row.rolbypassrls, false);
        }
        for (const pool of [domain, auth, worker]) {
          const role = (
            await pool.query(
              "SELECT rolsuper,rolbypassrls,rolcreaterole FROM pg_roles WHERE rolname=current_user",
            )
          ).rows[0];
          assert.deepEqual(role, {
            rolsuper: false,
            rolbypassrls: false,
            rolcreaterole: false,
          });
          await assert.rejects(
            pool.query(
              "SELECT * FROM domain.project_agreement_reservations($1,1)",
              [agreement],
            ),
            { code: "42501" },
          );
        }
        for (const pool of [auth, worker])
          await assert.rejects(
            pool.query("SELECT domain.lock_booking_agreements($1)", [booking]),
            { code: "42501" },
          );
        for (const [context, code] of [
          [undefined, "P0002"],
          [{ accountId: "citizen", tenantId: randomUUID() }, "P0002"],
          [{ accountId: "other", tenantId: tenant }, "42501"],
        ] as const) {
          await assert.rejects(
            transaction(domain, async (c) => {
              await setTransactionContext(c, context);
              await c.query("SELECT domain.lock_booking_agreements($1)", [
                booking,
              ]);
            }),
            { code },
          );
        }
        await transaction(domain, async (c) => {
          await setTransactionContext(c, {
            accountId: "citizen",
            tenantId: tenant,
          });
          await c.query("SELECT domain.lock_booking_agreements($1)", [booking]);
        });
        await assert.rejects(
          transaction(domain, async (c) => {
            await setTransactionContext(c, {
              accountId: "citizen",
              tenantId: tenant,
            });
            await c.query(
              "SELECT * FROM domain.project_agreement_reservations($1,1)",
              [agreement],
            );
          }),
          { code: "42501" },
        );
      },
    );
    await t.test(
      "reprogramming changes reservation, occupancy and quota week atomically",
      async () => {
        const move = async (updateConsumption: boolean) =>
          transaction(migration, async (c) => {
            await c.query(
              "UPDATE domain.reservation SET starts_at=starts_at+interval '7 days',ends_at=ends_at+interval '7 days' WHERE tenant_id=$1 AND id=$2",
              [tenant, booking],
            );
            await c.query(
              "UPDATE domain.occupancy SET released_at=now() WHERE tenant_id=$1 AND reservation_id=$2 AND released_at IS NULL",
              [tenant, booking],
            );
            await c.query(
              "INSERT INTO domain.occupancy(tenant_id,id,unit_id,reservation_id,period) SELECT tenant_id,$3,unit_id,id,tstzrange(starts_at,ends_at,'[)') FROM domain.reservation WHERE tenant_id=$1 AND id=$2",
              [tenant, booking, randomUUID()],
            );
            if (updateConsumption)
              await c.query(
                "UPDATE domain.agreement_consumption SET starts_at=starts_at+interval '7 days',ends_at=ends_at+interval '7 days',week_start=week_start+7 WHERE agreement_id=$1 AND tenant_id=$2 AND reservation_id=$3",
                [agreement, tenant, booking],
              );
          });
        await assert.rejects(move(false), { code: "23514" });
        assert.equal(
          (
            await migration.query(
              "SELECT starts_at FROM domain.reservation WHERE tenant_id=$1 AND id=$2",
              [tenant, booking],
            )
          ).rows[0].starts_at.toISOString(),
          start,
        );
        await move(true);
        const result = (
          await migration.query(
            "SELECT starts_at,to_char(week_start,'YYYY-MM-DD') AS week FROM domain.agreement_consumption",
          )
        ).rows[0];
        assert.equal(
          result.starts_at.toISOString(),
          "2030-04-07T22:00:00.000Z",
        );
        assert.equal(result.week, "2030-04-08");
      },
    );
    await t.test(
      "reservation changes cannot commit with stale active consumption",
      async () => {
        await assert.rejects(
          transaction(migration, async (c) => {
            await c.query(
              "UPDATE domain.reservation SET status='CANCELADA' WHERE tenant_id=$1 AND id=$2",
              [tenant, booking],
            );
            await c.query(
              "UPDATE domain.occupancy SET released_at=now() WHERE tenant_id=$1 AND reservation_id=$2",
              [tenant, booking],
            );
          }),
          { code: "23514" },
        );
        assert.equal(
          (
            await migration.query(
              "SELECT status FROM domain.reservation WHERE tenant_id=$1 AND id=$2",
              [tenant, booking],
            )
          ).rows[0].status,
          "CONFIRMADA",
        );
        await transaction(migration, async (c) => {
          await c.query(
            "UPDATE domain.reservation SET status='CANCELADA' WHERE tenant_id=$1 AND id=$2",
            [tenant, booking],
          );
          await c.query(
            "UPDATE domain.occupancy SET released_at=now() WHERE tenant_id=$1 AND reservation_id=$2",
            [tenant, booking],
          );
          await c.query(
            "UPDATE domain.agreement_consumption SET released=true WHERE agreement_id=$1 AND tenant_id=$2 AND reservation_id=$3",
            [agreement, tenant, booking],
          );
        });
        assert.equal(
          (
            await migration.query(
              "SELECT released FROM domain.agreement_consumption",
            )
          ).rows[0].released,
          true,
        );
        await assert.rejects(
          migration.query(
            "UPDATE domain.agreement_consumption SET released=false",
          ),
          { code: "23514" },
        );
      },
    );
  });
});
