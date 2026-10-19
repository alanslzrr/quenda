import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { transaction } from "../../src/database/transaction.ts";
import { suspendAgreement } from "../../src/modules/collaboration/index.ts";
import {
  cancelReservation,
  createReservation,
  modifyReservation,
} from "../../src/modules/reservations/index.ts";
import { withDatabase } from "../helpers/postgres.ts";

test("real booking commands enforce shared eligibility and quota in one transaction", {
  timeout: 60000,
}, async (t) => {
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
        "INSERT INTO domain.municipality(id,name,timezone) VALUES($1,'Synthetic','Europe/Madrid')",
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
        input(i, day),
        randomUUID(),
        3600,
        clock,
      );
    const cancel = (i: number, id: string, revision: number, key: string) =>
      cancelReservation(
        domain,
        actor,
        tenants[i] as string,
        id,
        key,
        { expectedRevision: revision },
        randomUUID(),
        3600,
        clock,
      );
    let winner = 0,
      booking = "";
    await t.test(
      "two municipalities competing for the last quota commit only one complete booking",
      async () => {
        const results = await Promise.allSettled([
          create(0, "quota-race"),
          create(1, "quota-race"),
        ]);
        assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          if (r?.status === "fulfilled") {
            winner = i;
            booking = r.value.result.id;
          } else if (r?.status === "rejected")
            assert.equal(r.reason.code, "CONFLICT");
        }
        for (const table of [
          "reservation",
          "occupancy",
          "reservation_event",
          "agreement_consumption",
          "agreement_consumption_event",
          "idempotent_command",
        ]) {
          assert.equal(
            (
              await migration.query(
                `SELECT count(*)::int AS n FROM domain.${table}`,
              )
            ).rows[0].n,
            1,
            table,
          );
        }
        await assert.rejects(create(1 - winner, "quota-full", 4), {
          code: "CONFLICT",
        });
        await cancel(winner, booking, 1, "cancel-quota");
        assert.equal(
          (
            await migration.query(
              "SELECT released FROM domain.agreement_consumption",
            )
          ).rows[0].released,
          true,
        );
      },
    );
    await t.test(
      "reprogramming moves the weekly quota; failure and no-op preserve prior effects",
      async () => {
        booking = (await create(winner, "new-after-cancel")).result.id;
        const moved = await modifyReservation(
          domain,
          actor,
          tenants[winner] as string,
          booking,
          "next-week",
          { ...input(winner, 10), expectedRevision: 1 },
          randomUUID(),
          3600,
          clock,
        );
        assert.equal(moved.result.revision, 2);
        await create(1 - winner, "previous-week", 4);
        const count = (
          await migration.query(
            "SELECT count(*)::int AS n FROM domain.agreement_consumption_event",
          )
        ).rows[0].n;
        await assert.rejects(
          modifyReservation(
            domain,
            actor,
            tenants[winner] as string,
            booking,
            "back-to-full-week",
            { ...input(winner, 5), expectedRevision: 2 },
            randomUUID(),
            3600,
            clock,
          ),
          { code: "CONFLICT" },
        );
        assert.equal(
          (
            await migration.query(
              "SELECT count(*)::int AS n FROM domain.agreement_consumption_event",
            )
          ).rows[0].n,
          count,
        );
        const invitation = randomUUID();
        await migration.query(
          "INSERT INTO domain.administrator_invitation(tenant_id,id,account_id,invited_by,expires_at,accepted_at) VALUES($1,$2,'citizen','citizen',now()+interval '1 day',now())",
          [tenants[winner], invitation],
        );
        await migration.query(
          "INSERT INTO domain.municipal_administrator(tenant_id,account_id,invitation_id) VALUES($1,'citizen',$2)",
          [tenants[winner], invitation],
        );
        const admin = { ...actor, mfaVerifiedAt: new Date() };
        await assert.rejects(
          suspendAgreement(
            domain,
            actor,
            tenants[winner] as string,
            agreement,
            "no-mfa",
            { version: 1, reason: "Safety review" },
            randomUUID(),
            3600,
          ),
          { code: "FORBIDDEN" },
        );
        const suspended = await suspendAgreement(
          domain,
          admin,
          tenants[winner] as string,
          agreement,
          "suspend",
          { version: 1, reason: "Safety review" },
          randomUUID(),
          3600,
        );
        assert.equal(suspended.result.status, "SUSPENDIDO");
        assert.equal(
          (
            await suspendAgreement(
              domain,
              admin,
              tenants[winner] as string,
              agreement,
              "suspend",
              { version: 1, reason: "Safety review" },
              randomUUID(),
              3600,
            )
          ).replayed,
          true,
        );
        await suspendAgreement(
          domain,
          admin,
          tenants[winner] as string,
          agreement,
          "repeat-suspend",
          { version: 1, reason: "Another reason" },
          randomUUID(),
          3600,
        );
        const audit = (
          await migration.query(
            "SELECT reason,actor_id,actor_tenant_id FROM domain.agreement_lifecycle_event WHERE agreement_id=$1",
            [agreement],
          )
        ).rows;
        assert.deepEqual(audit, [
          {
            reason: "Safety review",
            actor_id: "citizen",
            actor_tenant_id: tenants[winner],
          },
        ]);
        assert.equal(
          (
            await migration.query(
              "SELECT count(*)::int AS n FROM domain.agreement_assignment WHERE agreement_id=$1 AND effective_period @> clock_timestamp()",
              [agreement],
            )
          ).rows[0].n,
          0,
        );
        assert.equal(
          (
            await migration.query(
              "SELECT count(*)::int AS n FROM domain.unit_agreement_gate WHERE agreement_id=$1",
              [agreement],
            )
          ).rows[0].n,
          2,
        );

        const publicUnit = randomUUID();
        await migration.query(
          "INSERT INTO domain.reservable_unit(tenant_id,id,facility_id,name) SELECT tenant_id,$3,facility_id,'Public unit' FROM domain.reservable_unit WHERE tenant_id=$1 AND id=$2",
          [tenants[winner], units[winner], publicUnit],
        );
        await migration.query(
          "INSERT INTO domain.unit_calendar_version(tenant_id,unit_id,version,minimum_minutes,maximum_minutes,step_minutes,weekly,exceptions,actor_id,reason) SELECT tenant_id,$3,1,minimum_minutes,maximum_minutes,step_minutes,weekly,exceptions,'citizen','Fixture' FROM domain.unit_calendar_version WHERE tenant_id=$1 AND unit_id=$2 AND version=1",
          [tenants[winner], units[winner], publicUnit],
        );
        await migration.query(
          "UPDATE domain.reservable_unit SET calendar_version=1,published_at=now() WHERE tenant_id=$1 AND id=$2",
          [tenants[winner], publicUnit],
        );
        await assert.rejects(
          modifyReservation(
            domain,
            actor,
            tenants[winner] as string,
            booking,
            "suspended-to-public",
            { ...input(winner, 11), unitId: publicUnit, expectedRevision: 2 },
            randomUUID(),
            3600,
            clock,
          ),
          { code: "CONFLICT" },
        );
        const noop = await modifyReservation(
          domain,
          actor,
          tenants[winner] as string,
          booking,
          "noop",
          { ...input(winner, 10), expectedRevision: 2 },
          randomUUID(),
          3600,
          clock,
        );
        assert.equal(noop.result.revision, 2);
        assert.equal(
          (
            await migration.query(
              "SELECT count(*)::int AS n FROM domain.agreement_consumption_event",
            )
          ).rows[0].n,
          count,
        );
        await assert.rejects(create(winner, "suspended", 11), {
          code: "CONFLICT",
        });
        await cancel(winner, booking, 2, "cancel-suspended");
        // Restore an active lifecycle fixture for the independent eligibility scenario.
        await migration.query(
          "UPDATE domain.agreement_activation SET effective_period='[2020-01-01T00:00:00Z,2040-01-01T00:00:00Z)' WHERE agreement_id=$1",
          [agreement],
        );
        await migration.query(
          "UPDATE domain.agreement_version SET status='ACTIVADO',weekly_limit=NULL,eligibility='acreditacion_vigente' WHERE agreement_id=$1",
          [agreement],
        );
      },
    );
    await t.test(
      "eligibility covers the whole interval and revoked evidence never grants another booking",
      async () => {
        await assert.rejects(create(winner, "no-credential", 12), {
          code: "CONFLICT",
        });
        const subject = (
          await migration.query(
            "SELECT id FROM domain.agreement_subject WHERE agreement_id=$1 AND account_id='citizen'",
            [agreement],
          )
        ).rows[0].id;
        const credential = randomUUID();
        await migration.query(
          "INSERT INTO domain.agreement_credential(id,agreement_id,issued_version,issuer_tenant_id,subject_id,starts_at,ends_at,verification_reference,issued_by,correlation_id) VALUES($1,$2,1,$3,$4,'2030-04-12T10:00:00Z','2030-04-12T10:30:00Z','Fixture verified','citizen',$5)",
          [credential, agreement, tenants[1 - winner], subject, randomUUID()],
        );
        await assert.rejects(create(winner, "short-credential", 12), {
          code: "CONFLICT",
        });
        await migration.query(
          "UPDATE domain.agreement_credential SET ends_at='2030-04-15T00:00:00Z' WHERE id=$1",
          [credential],
        );
        const accepted = await create(winner, "eligible", 12);
        const evidence = (
          await migration.query(
            "SELECT credential_id FROM domain.agreement_consumption_event WHERE reservation_id=$1 AND action='ATTRIBUTED'",
            [accepted.result.id],
          )
        ).rows[0];
        assert.equal(evidence.credential_id, credential);
        await migration.query(
          "UPDATE domain.agreement_credential SET revoked_at=now(),revoked_by='citizen',revocation_reason='Fixture withdrawn',revocation_correlation_id=$2 WHERE id=$1",
          [credential, randomUUID()],
        );
        await assert.rejects(create(winner, "revoked", 13), {
          code: "CONFLICT",
        });
        await cancel(winner, accepted.result.id, 1, "cancel-after-revoke");
        await migration.query(
          "UPDATE domain.agreement_activation SET effective_period='empty' WHERE agreement_id=$1",
          [agreement],
        );
        await assert.rejects(create(winner, "no-public-fallback", 14), {
          code: "CONFLICT",
        });
      },
    );
  });
});
