import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { transaction } from "../../src/database/transaction.ts";
import { createReservation } from "../../src/modules/reservations/index.ts";
import { withDatabase } from "../helpers/postgres.ts";
import {
  initialAcceptance,
  seedUsageRules,
} from "../helpers/usage-rules-fixture.ts";

test("initial scheduled agreement restrictions preserve public intervals ending before their start", {
  timeout: 60000,
}, async () => {
  await withDatabase(async ({ domain, auth, migration }) => {
    await auth.query(
      'INSERT INTO auth."user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES(\'citizen\',\'Citizen\',\'citizen@example.test\',true,now(),now())',
    );
    const tenants = [randomUUID(), randomUUID()],
      units = [randomUUID(), randomUUID()],
      agreement = randomUUID();
    for (let i = 0; i < 2; i++) {
      const facility = randomUUID();
      await migration.query(
        "INSERT INTO domain.municipality(id,name,timezone,cancellation_minutes) VALUES($1,'Synthetic','Europe/Madrid',0)",
        [tenants[i]],
      );
      await migration.query(
        "INSERT INTO domain.facility(tenant_id,id,name,published_at) VALUES($1,$2,'Facility',now())",
        [tenants[i], facility],
      );
      await migration.query(
        "INSERT INTO domain.reservable_unit(tenant_id,id,facility_id,name) VALUES($1,$2,$3,'Unit')",
        [tenants[i], units[i], facility],
      );
      await migration.query(
        "INSERT INTO domain.unit_calendar_version(tenant_id,unit_id,version,minimum_minutes,maximum_minutes,step_minutes,weekly,exceptions,actor_id,reason) VALUES($1,$2,1,30,120,30,$3,'[]','citizen','Fixture')",
        [
          tenants[i],
          units[i],
          JSON.stringify(
            Array.from({ length: 7 }, (_, n) => ({
              day: n + 1,
              startMinute: 0,
              endMinute: 1440,
            })),
          ),
        ],
      );
      await seedUsageRules(
        migration,
        tenants[i] as string,
        units[i] as string,
        "citizen",
      );
      await migration.query(
        "UPDATE domain.reservable_unit SET calendar_version=1,published_at=now() WHERE tenant_id=$1 AND id=$2",
        [tenants[i], units[i]],
      );
    }
    // Approved/activated lifecycle fixture; booking commands themselves are real.
    await transaction(migration, async (c) => {
      await c.query(
        "INSERT INTO domain.agreement(id,name,timezone,created_by,created_by_tenant) VALUES($1,'Joint','Europe/Madrid','citizen',$2)",
        [agreement, tenants[0]],
      );
      await c.query(
        "INSERT INTO domain.agreement_version(agreement_id,version,status,starts_at,ends_at,purpose,legal_basis,responsibilities,retention_policy,eligibility,weekly_limit,aggregate_reports,created_by,correlation_id) VALUES($1,1,'ACTIVADO','2020-01-01T00:00:00Z','2040-01-01T00:00:00Z','Purpose','Reference','Municipal','Policy','acceso_abierto',1,false,'citizen',$2)",
        [agreement, randomUUID()],
      );
      await c.query(
        "INSERT INTO domain.agreement_activation(agreement_id,version,effective_period,activated_by,correlation_id) VALUES($1,1,'[2020-01-01T00:00:00Z,2040-01-01T00:00:00Z)','citizen',$2)",
        [agreement, randomUUID()],
      );
      for (let i = 0; i < 2; i++) {
        await c.query(
          "INSERT INTO domain.agreement_participant VALUES($1,1,$2,true)",
          [agreement, tenants[i]],
        );
        await c.query("INSERT INTO domain.agreement_unit VALUES($1,1,$2,$3)", [
          agreement,
          tenants[i],
          units[i],
        ]);
        await c.query(
          "INSERT INTO domain.agreement_assignment VALUES($1,1,$2,$3,'[2020-01-01T00:00:00Z,2040-01-01T00:00:00Z)')",
          [agreement, tenants[i], units[i]],
        );
        await c.query(
          "INSERT INTO domain.unit_agreement_gate VALUES($1,$2,$3,1)",
          [tenants[i], units[i], agreement],
        );
      }
    });
    const actor = {
      accountId: "citizen",
      email: "citizen@example.test",
      sessionId: "verified",
      mfaVerifiedAt: null,
    };
    const clock = { now: () => new Date("2030-04-02T00:00:00Z") };
    const input = (i: number, day = 3) => ({
      unitId: units[i] as string,
      startsAt: `2030-04-${String(day).padStart(2, "0")}T10:00:00.000Z`,
      endsAt: `2030-04-${String(day).padStart(2, "0")}T11:00:00.000Z`,
    });
    const create = (i: number, key: string, day = 3) =>
      createReservation(
        domain,
        actor,
        tenants[i] as string,
        key,
        {
          acceptance: initialAcceptance,
          ...input(i, day),
        },
        randomUUID(),
        3600,
        clock,
      );
    await transaction(migration, async (c) => {
      await c.query(
        "DELETE FROM domain.unit_agreement_gate WHERE agreement_id=$1",
        [agreement],
      );
      await c.query(
        "UPDATE domain.agreement_version SET starts_at='2030-04-04T10:00:00Z' WHERE agreement_id=$1",
        [agreement],
      );
      await c.query(
        "UPDATE domain.agreement_activation SET effective_period='[2030-04-04T10:00:00Z,2040-01-01T00:00:00Z)' WHERE agreement_id=$1",
        [agreement],
      );
      await c.query(
        "UPDATE domain.agreement_assignment SET effective_period='[2030-04-04T10:00:00Z,2040-01-01T00:00:00Z)' WHERE agreement_id=$1",
        [agreement],
      );
      await c.query(
        "INSERT INTO domain.unit_agreement_gate(tenant_id,unit_id,agreement_id,version) SELECT tenant_id,unit_id,agreement_id,version FROM domain.agreement_assignment WHERE agreement_id=$1",
        [agreement],
      );
    });
    await create(0, "pre-start", 3);
    const book = (key: string, startsAt: string, endsAt: string, index = 0) =>
      createReservation(
        domain,
        actor,
        tenants[index] as string,
        key,
        {
          unitId: units[index] as string,
          startsAt,
          endsAt,
          acceptance: initialAcceptance,
        },
        randomUUID(),
        3600,
        clock,
      );
    await book("boundary", "2030-04-04T09:00:00Z", "2030-04-04T10:00:00Z", 1);
    assert.equal(
      (
        await migration.query(
          "SELECT count(*)::int n FROM domain.agreement_consumption WHERE agreement_id=$1",
          [agreement],
        )
      ).rows[0].n,
      0,
    );
    for (const [key, start, end] of [
      ["crossing", "2030-04-04T09:30:00Z", "2030-04-04T10:30:00Z"],
      ["future", "2030-04-04T10:00:00Z", "2030-04-04T11:00:00Z"],
    ])
      await assert.rejects(
        book(key as string, start as string, end as string),
        { code: "AGREEMENT_UNAVAILABLE" },
      );
    await migration.query(
      "UPDATE domain.agreement_version SET status='SUSPENDIDO' WHERE agreement_id=$1",
      [agreement],
    );
    await assert.rejects(
      book("suspended", "2030-04-03T12:00:00Z", "2030-04-03T13:00:00Z"),
      { code: "AGREEMENT_UNAVAILABLE" },
    );
    await migration.query(
      "UPDATE domain.agreement_version SET status='ACTIVADO' WHERE agreement_id=$1",
      [agreement],
    );
    // A replacement may never postpone a restriction which already took effect.
    for (const period of [
      "[2020-01-01,2040-01-01)",
      "[2030-04-04T10:00:00Z,2040-01-01)",
    ]) {
      await transaction(migration, async (c) => {
        await c.query(
          "UPDATE domain.agreement_version SET starts_at=lower($2::tstzrange) WHERE agreement_id=$1",
          [agreement, period],
        );
        await c.query(
          "UPDATE domain.agreement_activation SET effective_period=$2 WHERE agreement_id=$1",
          [agreement, period],
        );
        await c.query(
          "UPDATE domain.agreement_assignment SET effective_period=$2 WHERE agreement_id=$1",
          [agreement, period],
        );
        await c.query(
          "UPDATE domain.unit_agreement_gate SET version=version WHERE agreement_id=$1",
          [agreement],
        );
      });
    }
    await assert.rejects(
      book("no-reopen", "2030-04-03T12:00:00Z", "2030-04-03T13:00:00Z"),
      { code: "AGREEMENT_UNAVAILABLE" },
    );
  });
});
