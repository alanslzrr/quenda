import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { setTransactionContext } from "../../src/database/context.ts";
import { transaction } from "../../src/database/transaction.ts";
import {
  activateAgreement,
  approveAgreement,
  createAgreementDraft,
  createAgreementVersion,
  readUnitAgreementRestriction,
  releaseUnitAgreementRestriction,
  suspendAgreement,
} from "../../src/modules/collaboration/index.ts";
import {
  cancelReservation,
  createReservation,
  modifyReservation,
  readReservation,
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
    await t.test(
      "booking and suspension serialize in both verified lock orderings",
      async () => {
        const tenant = tenants[winner] as string;
        const admin = { ...actor, mfaVerifiedAt: new Date() };
        const restore = async () => {
          await migration.query(
            "UPDATE domain.agreement_activation SET effective_period='[2020-01-01T00:00:00Z,2040-01-01T00:00:00Z)' WHERE agreement_id=$1",
            [agreement],
          );
          await migration.query(
            "UPDATE domain.agreement_version SET status='ACTIVADO',eligibility='acceso_abierto',weekly_limit=NULL WHERE agreement_id=$1",
            [agreement],
          );
        };
        const blockedBy = async (pid: number) => {
          const until = Date.now() + 5000;
          while (Date.now() < until) {
            const rows = (
              await migration.query(
                "SELECT DISTINCT l.pid FROM pg_locks l WHERE NOT l.granted AND $1::integer=ANY(pg_blocking_pids(l.pid))",
                [pid],
              )
            ).rows;
            if (rows.length) return rows[0].pid as number;
            await delay(10);
          }
          throw new Error("Expected blocked peer did not appear");
        };
        await restore();
        const gate = await migration.connect();
        let bookingAttempt: ReturnType<typeof create> | undefined;
        let suspensionAttempt: ReturnType<typeof suspendAgreement> | undefined;
        try {
          const pid = (await gate.query("SELECT pg_backend_pid() AS pid"))
            .rows[0].pid as number;
          await gate.query("SELECT pg_advisory_lock(9055)");
          await migration.query(
            "CREATE FUNCTION domain.pause_booking_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(9055); RETURN NEW; END $$",
          );
          await migration.query(
            "CREATE TRIGGER pause_booking_fixture BEFORE INSERT ON domain.agreement_consumption_event FOR EACH ROW WHEN (NEW.action='ATTRIBUTED') EXECUTE FUNCTION domain.pause_booking_fixture()",
          );
          bookingAttempt = create(winner, "booking-before-suspend", 17);
          void bookingAttempt.catch(() => {});
          const bookingPid = await blockedBy(pid);
          suspensionAttempt = suspendAgreement(
            domain,
            admin,
            tenant,
            agreement,
            "suspend-after-booking",
            { version: 1, reason: "Verified booking-first ordering" },
            randomUUID(),
            3600,
          );
          void suspensionAttempt.catch(() => {});
          await blockedBy(bookingPid);
          await gate.query("SELECT pg_advisory_unlock(9055)");
          const booked = await bookingAttempt;
          assert.equal((await suspensionAttempt).result.status, "SUSPENDIDO");
          assert.equal(
            (
              await readReservation(
                domain,
                actor,
                tenant,
                booked.result.id,
                clock,
              )
            ).status,
            "CONFIRMADA",
          );
          await assert.rejects(
            create(winner, "new-after-serialized-suspend", 18),
            { code: "CONFLICT" },
          );
          await cancel(
            winner,
            booked.result.id,
            1,
            "cancel-serialized-booking",
          );
        } finally {
          await gate.query("SELECT pg_advisory_unlock_all()");
          gate.release();
          await Promise.allSettled(
            [bookingAttempt, suspensionAttempt].filter((p) => p !== undefined),
          );
          await migration.query(
            "DROP TRIGGER IF EXISTS pause_booking_fixture ON domain.agreement_consumption_event; DROP FUNCTION IF EXISTS domain.pause_booking_fixture()",
          );
        }
        await restore();
        const holder = await domain.connect();
        let pending: ReturnType<typeof create> | undefined;
        const before = (
          await migration.query(
            "SELECT count(*)::integer AS n FROM domain.reservation",
          )
        ).rows[0].n;
        try {
          await holder.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
          await setTransactionContext(holder, {
            accountId: actor.accountId,
            tenantId: tenant,
          });
          const pid = (await holder.query("SELECT pg_backend_pid() AS pid"))
            .rows[0].pid as number;
          await holder.query(
            "SELECT domain.suspend_agreement($1,1,'Verified suspension-first ordering',$2)",
            [agreement, randomUUID()],
          );
          pending = create(winner, "booking-after-suspend", 18);
          void pending.catch(() => {});
          await blockedBy(pid);
          await holder.query("COMMIT");
          await assert.rejects(pending, { code: "CONFLICT" });
          assert.equal(
            (
              await migration.query(
                "SELECT count(*)::integer AS n FROM domain.reservation",
              )
            ).rows[0].n,
            before,
          );
        } finally {
          await holder.query("ROLLBACK");
          holder.release();
          if (pending) await Promise.allSettled([pending]);
        }
      },
    );
    await t.test(
      "expired effective periods block new bookings and changes without a status worker or public fallback",
      async () => {
        await migration.query(
          "UPDATE domain.agreement_activation SET effective_period='[2020-01-01T00:00:00Z,2040-01-01T00:00:00Z)' WHERE agreement_id=$1",
          [agreement],
        );
        await migration.query(
          "UPDATE domain.agreement_version SET status='ACTIVADO',eligibility='acceso_abierto',weekly_limit=NULL WHERE agreement_id=$1",
          [agreement],
        );
        const retained = await create(winner, "before-expiry", 15);
        const tenant = tenants[winner] as string;
        const before = await readReservation(
          domain,
          actor,
          tenant,
          retained.result.id,
          clock,
        );
        // Move the effective end into the past; no lifecycle worker changes status.
        await migration.query(
          "UPDATE domain.agreement_activation SET effective_period=tstzrange(lower(effective_period),clock_timestamp()-interval '1 second','[)') WHERE agreement_id=$1",
          [agreement],
        );
        assert.deepEqual(
          (
            await migration.query(
              "SELECT v.status,a.effective_period @> clock_timestamp() AS effective,isempty(a.effective_period) AS empty FROM domain.agreement_version v JOIN domain.agreement_activation a USING(agreement_id,version) WHERE v.agreement_id=$1",
              [agreement],
            )
          ).rows[0],
          { status: "ACTIVADO", effective: false, empty: false },
        );
        await assert.rejects(create(winner, "after-expiry", 16), {
          code: "CONFLICT",
        });
        await assert.rejects(
          modifyReservation(
            domain,
            actor,
            tenant,
            retained.result.id,
            "change-after-expiry",
            { ...input(winner, 16), expectedRevision: 1 },
            randomUUID(),
            3600,
            clock,
          ),
          { code: "CONFLICT" },
        );
        assert.deepEqual(
          await readReservation(
            domain,
            actor,
            tenant,
            retained.result.id,
            clock,
          ),
          before,
        );
        assert.equal(
          (
            await migration.query(
              "SELECT released FROM domain.agreement_consumption WHERE agreement_id=$1 AND reservation_id=$2",
              [agreement, retained.result.id],
            )
          ).rows[0].released,
          false,
        );
        assert.equal(
          (
            await migration.query(
              "SELECT count(*)::integer AS n FROM domain.unit_agreement_gate WHERE agreement_id=$1",
              [agreement],
            )
          ).rows[0].n,
          2,
        );
        await cancel(winner, retained.result.id, 1, "cancel-expired");
        assert.equal(
          (
            await readReservation(
              domain,
              actor,
              tenant,
              retained.result.id,
              clock,
            )
          ).status,
          "CANCELADA",
        );
        assert.equal(
          (
            await migration.query(
              "SELECT released FROM domain.agreement_consumption WHERE agreement_id=$1 AND reservation_id=$2",
              [agreement, retained.result.id],
            )
          ).rows[0].released,
          true,
        );
        await assert.rejects(create(winner, "still-not-public", 15), {
          code: "CONFLICT",
        });
      },
    );
    await t.test(
      "technical consumption failures roll back booking, occupancy, notices and idempotency before retry",
      async () => {
        await migration.query(
          "UPDATE domain.agreement_activation SET effective_period='[2020-01-01T00:00:00Z,2040-01-01T00:00:00Z)' WHERE agreement_id=$1",
          [agreement],
        );
        const counts = async () => {
          const result: Record<string, number> = {};
          for (const table of [
            "reservation",
            "occupancy",
            "reservation_event",
            "reservation_notice",
            "reservation_email",
            "agreement_consumption",
            "agreement_consumption_event",
            "idempotent_command",
          ])
            result[table] = (
              await migration.query(
                `SELECT count(*)::integer AS n FROM domain.${table}`,
              )
            ).rows[0].n;
          return result;
        };
        const before = await counts();
        await migration.query(
          "CREATE FUNCTION domain.fail_consumption_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Fixture unavailable' USING ERRCODE='XX000'; END $$",
        );
        await migration.query(
          "CREATE TRIGGER fail_consumption_fixture BEFORE INSERT ON domain.agreement_consumption_event FOR EACH ROW EXECUTE FUNCTION domain.fail_consumption_fixture()",
        );
        try {
          await assert.rejects(
            create(winner, "technical-consumption-retry", 16),
            { code: "XX000" },
          );
          assert.deepEqual(await counts(), before);
        } finally {
          await migration.query(
            "DROP TRIGGER fail_consumption_fixture ON domain.agreement_consumption_event; DROP FUNCTION domain.fail_consumption_fixture()",
          );
        }
        const retried = await create(winner, "technical-consumption-retry", 16);
        assert.equal(retried.replayed, false);
        const after = await counts();
        for (const table of Object.keys(before))
          assert.equal(after[table], before[table]! + 1, table);
        await cancel(winner, retried.result.id, 1, "cancel-technical-retry");
        await migration.query(
          "UPDATE domain.agreement_activation SET effective_period='empty' WHERE agreement_id=$1",
          [agreement],
        );
      },
    );
    await t.test(
      "activation, version changes and cross-agreement moves preserve quotas and atomicity",
      async (scenario) => {
        const tenant = tenants[winner] as string;
        const publicUnit = (
          await migration.query(
            "SELECT id FROM domain.reservable_unit WHERE tenant_id=$1 AND name='Public unit'",
            [tenant],
          )
        ).rows[0].id;
        const prior: { id: string }[] = [];
        for (const day of [18, 19])
          prior.push(
            (
              await createReservation(
                domain,
                actor,
                tenant,
                `before-activation-${day}`,
                { ...input(winner, day), unitId: publicUnit },
                randomUUID(),
                3600,
                clock,
              )
            ).result,
          );
        const otherTenant = tenants[1 - winner] as string;
        const invite = randomUUID();
        await migration.query(
          "INSERT INTO domain.administrator_invitation(tenant_id,id,account_id,invited_by,expires_at,accepted_at) VALUES($1,$2,'citizen','citizen',now()+interval '1 day',now())",
          [otherTenant, invite],
        );
        await migration.query(
          "INSERT INTO domain.municipal_administrator(tenant_id,account_id,invitation_id) VALUES($1,'citizen',$2)",
          [otherTenant, invite],
        );
        const activationTenant = [...tenants].sort()[0] as string;
        const admin = { ...actor, mfaVerifiedAt: new Date() };
        const draft = await createAgreementDraft(
          domain,
          admin,
          tenant,
          "activate-draft",
          {
            name: "Reconciliation",
            timeZone: "Europe/Madrid",
            startsAt: "2020-01-01T00:00:00Z",
            endsAt: "2040-01-01T00:00:00Z",
            purpose: "Shared service",
            legalBasis: "Synthetic basis",
            responsibilities: "Municipal management",
            retentionPolicy: "Synthetic policy",
            eligibility: "acceso_abierto",
            weeklyLimit: 1,
            aggregateReports: false,
            participants: [
              {
                tenantId: tenant,
                accreditationIssuer: false,
                unitIds: [publicUnit],
              },
              {
                tenantId: otherTenant,
                accreditationIssuer: false,
                unitIds: [],
              },
            ],
          },
          randomUUID(),
          3600,
        );
        const id = draft.result.agreementId;
        const evidence = {
          version: 1,
          legalReviewReference: "Synthetic reviewed basis",
          reportReviewReference: null,
        };
        await assert.rejects(
          activateAgreement(
            domain,
            admin,
            activationTenant,
            id,
            "unapproved",
            evidence,
            randomUUID(),
            3600,
          ),
          { code: "CONFLICT" },
        );
        await approveAgreement(
          domain,
          admin,
          tenant,
          id,
          "approval",
          { version: 1, unitIds: [publicUnit] },
          randomUUID(),
          3600,
        );
        await assert.rejects(
          activateAgreement(
            domain,
            actor,
            activationTenant,
            id,
            "activation-no-mfa",
            evidence,
            randomUUID(),
            3600,
          ),
          { code: "FORBIDDEN" },
        );
        await assert.rejects(
          activateAgreement(
            domain,
            admin,
            activationTenant,
            id,
            "no-review",
            { ...evidence, legalReviewReference: " " },
            randomUUID(),
            3600,
          ),
          { code: "INVALID_INPUT" },
        );
        await assert.rejects(
          activateAgreement(
            domain,
            admin,
            activationTenant,
            id,
            "missing-participant",
            evidence,
            randomUUID(),
            3600,
          ),
          { code: "CONFLICT" },
        );
        await approveAgreement(
          domain,
          admin,
          otherTenant,
          id,
          "other-approval",
          { version: 1, unitIds: [] },
          randomUUID(),
          3600,
        );
        const activated = await activateAgreement(
          domain,
          admin,
          activationTenant,
          id,
          "activate",
          evidence,
          randomUUID(),
          3600,
        );
        assert.equal(activated.result.status, "ACTIVADO");
        assert.equal(
          (
            await activateAgreement(
              domain,
              admin,
              activationTenant,
              id,
              "activate",
              evidence,
              randomUUID(),
              3600,
            )
          ).replayed,
          true,
        );
        assert.equal(
          (
            await migration.query(
              "SELECT count(*)::int AS n FROM domain.agreement_consumption WHERE agreement_id=$1 AND NOT released",
              [id],
            )
          ).rows[0].n,
          2,
        );
        assert.equal(
          (
            await migration.query(
              "SELECT count(*)::int AS n FROM domain.agreement_consumption_event WHERE agreement_id=$1 AND action='RECONCILED'",
              [id],
            )
          ).rows[0].n,
          2,
        );
        for (const r of prior)
          assert.equal(
            (
              await migration.query(
                "SELECT status FROM domain.reservation WHERE tenant_id=$1 AND id=$2",
                [tenant, r.id],
              )
            ).rows[0].status,
            "CONFIRMADA",
          );
        await assert.rejects(
          createReservation(
            domain,
            actor,
            tenant,
            "over-reconciled-quota",
            { ...input(winner, 20), unitId: publicUnit },
            randomUUID(),
            3600,
            clock,
          ),
          { code: "CONFLICT" },
        );
        assert.equal(
          (
            await domain.query(
              "SELECT nullif(current_setting('quenda.tenant_id',true),'') AS tenant",
            )
          ).rows[0].tenant,
          null,
        );
        await assert.rejects(
          domain.query(
            "SELECT * FROM domain.project_agreement_reservations($1,1)",
            [id],
          ),
          { code: "42501" },
        );
        await assert.rejects(
          activateAgreement(
            domain,
            admin,
            activationTenant,
            id,
            "second-activation",
            evidence,
            randomUUID(),
            3600,
          ),
          { code: "CONFLICT" },
        );
        assert.equal(
          (
            await migration.query(
              "SELECT count(*)::int AS n FROM domain.agreement_lifecycle_event WHERE agreement_id=$1 AND action='ACTIVATED'",
              [id],
            )
          ).rows[0].n,
          1,
        );
        const definition = {
          startsAt: "2020-01-01T00:00:00Z",
          endsAt: "2040-01-01T00:00:00Z",
          purpose: "Shared service",
          legalBasis: "Synthetic basis",
          responsibilities: "Municipal management",
          retentionPolicy: "Synthetic policy",
          eligibility: "acceso_abierto" as const,
          weeklyLimit: 2,
          aggregateReports: false,
          participants: [
            {
              tenantId: tenant,
              accreditationIssuer: false,
              unitIds: [publicUnit],
            },
            { tenantId: otherTenant, accreditationIssuer: false, unitIds: [] },
          ],
        };
        const next = await createAgreementVersion(
          domain,
          admin,
          tenant,
          id,
          "version-two",
          { ...definition, expectedVersion: 1 },
          randomUUID(),
          3600,
        );
        assert.equal(next.result.version, 2);
        await assert.rejects(
          activateAgreement(
            domain,
            admin,
            activationTenant,
            id,
            "unapproved-replacement",
            { ...evidence, version: 2 },
            randomUUID(),
            3600,
          ),
          { code: "CONFLICT" },
        );
        for (const p of definition.participants)
          await approveAgreement(
            domain,
            admin,
            p.tenantId,
            id,
            "approve-two",
            { version: 2, unitIds: p.unitIds },
            randomUUID(),
            3600,
          );
        await activateAgreement(
          domain,
          admin,
          activationTenant,
          id,
          "replace",
          { ...evidence, version: 2 },
          randomUUID(),
          3600,
        );
        assert.equal(
          (
            await migration.query(
              "SELECT count(*)::int AS n FROM domain.agreement_activation WHERE agreement_id=$1 AND effective_period @> clock_timestamp()",
              [id],
            )
          ).rows[0].n,
          1,
        );
        assert.equal(
          (
            await migration.query(
              "SELECT count(*)::int AS n FROM domain.agreement_consumption WHERE agreement_id=$1 AND NOT released",
              [id],
            )
          ).rows[0].n,
          2,
        );
        assert.equal(
          (
            await migration.query(
              "SELECT count(*)::int AS n FROM domain.agreement_lifecycle_event WHERE agreement_id=$1 AND action='REPLACED' AND previous_period IS NOT NULL AND effective_period IS NOT NULL",
              [id],
            )
          ).rows[0].n,
          1,
        );
        await assert.rejects(
          createReservation(
            domain,
            actor,
            tenant,
            "no-quota-reset",
            { ...input(winner, 20), unitId: publicUnit },
            randomUUID(),
            3600,
            clock,
          ),
          { code: "CONFLICT" },
        );
        await suspendAgreement(
          domain,
          admin,
          activationTenant,
          id,
          "suspend-replaced",
          { version: 2, reason: "Synthetic review" },
          randomUUID(),
          3600,
        );
        await assert.rejects(
          activateAgreement(
            domain,
            admin,
            activationTenant,
            id,
            "cannot-reuse-version",
            { ...evidence, version: 2 },
            randomUUID(),
            3600,
          ),
          { code: "CONFLICT" },
        );
        await createAgreementVersion(
          domain,
          admin,
          tenant,
          id,
          "version-three",
          { ...definition, weeklyLimit: 3, expectedVersion: 2 },
          randomUUID(),
          3600,
        );
        for (const p of definition.participants)
          await approveAgreement(
            domain,
            admin,
            p.tenantId,
            id,
            "approve-three",
            { version: 3, unitIds: p.unitIds },
            randomUUID(),
            3600,
          );
        await activateAgreement(
          domain,
          admin,
          activationTenant,
          id,
          "reactivate",
          { ...evidence, version: 3 },
          randomUUID(),
          3600,
        );
        assert.equal(
          (
            await migration.query(
              "SELECT count(*)::int AS n FROM domain.agreement_consumption WHERE agreement_id=$1 AND NOT released",
              [id],
            )
          ).rows[0].n,
          2,
        );
        assert.equal(
          (
            await createReservation(
              domain,
              actor,
              tenant,
              "remaining-quota",
              { ...input(winner, 20), unitId: publicUnit },
              randomUUID(),
              3600,
              clock,
            )
          ).result.status,
          "CONFIRMADA",
        );
        const replacementUnit = randomUUID();
        await migration.query(
          "INSERT INTO domain.reservable_unit(tenant_id,id,facility_id,name) SELECT tenant_id,$3,facility_id,'Replacement unit' FROM domain.reservable_unit WHERE tenant_id=$1 AND id=$2",
          [tenant, publicUnit, replacementUnit],
        );
        await migration.query(
          "INSERT INTO domain.unit_calendar_version(tenant_id,unit_id,version,minimum_minutes,maximum_minutes,step_minutes,weekly,exceptions,actor_id,reason) SELECT tenant_id,$3,1,minimum_minutes,maximum_minutes,step_minutes,weekly,exceptions,'citizen','Fixture' FROM domain.unit_calendar_version WHERE tenant_id=$1 AND unit_id=$2 AND version=1",
          [tenant, publicUnit, replacementUnit],
        );
        await migration.query(
          "UPDATE domain.reservable_unit SET calendar_version=1,published_at=now() WHERE tenant_id=$1 AND id=$2",
          [tenant, replacementUnit],
        );
        const movedUnits = definition.participants.map((p) => ({
          ...p,
          unitIds: p.tenantId === tenant ? [replacementUnit] : [],
        }));
        await createAgreementVersion(
          domain,
          admin,
          tenant,
          id,
          "version-four",
          {
            ...definition,
            participants: movedUnits,
            weeklyLimit: 3,
            expectedVersion: 3,
          },
          randomUUID(),
          3600,
        );
        for (const p of movedUnits)
          await approveAgreement(
            domain,
            admin,
            p.tenantId,
            id,
            "approve-four",
            { version: 4, unitIds: p.unitIds },
            randomUUID(),
            3600,
          );
        await activateAgreement(
          domain,
          admin,
          activationTenant,
          id,
          "replace-units",
          { ...evidence, version: 4 },
          randomUUID(),
          3600,
        );
        assert.equal(
          (
            await migration.query(
              "SELECT count(*)::int AS n FROM domain.agreement_consumption WHERE agreement_id=$1 AND NOT released",
              [id],
            )
          ).rows[0].n,
          3,
        );
        await assert.rejects(
          createReservation(
            domain,
            actor,
            tenant,
            "removed-unit",
            { ...input(winner, 21), unitId: publicUnit },
            randomUUID(),
            3600,
            clock,
          ),
          { code: "CONFLICT" },
        );
        await assert.rejects(
          createReservation(
            domain,
            actor,
            tenant,
            "retained-quota",
            { ...input(winner, 21), unitId: replacementUnit },
            randomUUID(),
            3600,
            clock,
          ),
          { code: "CONFLICT" },
        );
        const previous = prior[0];
        assert.ok(previous);
        await cancelReservation(
          domain,
          actor,
          tenant,
          previous.id,
          "cancel-removed-unit",
          { expectedRevision: 1 },
          randomUUID(),
          3600,
          clock,
        );
        assert.equal(
          (
            await createReservation(
              domain,
              actor,
              tenant,
              "quota-after-cancel",
              { ...input(winner, 21), unitId: replacementUnit },
              randomUUID(),
              3600,
              clock,
            )
          ).result.status,
          "CONFIRMADA",
        );
        const destinationUnit = randomUUID();
        await migration.query(
          "INSERT INTO domain.reservable_unit(tenant_id,id,facility_id,name) SELECT tenant_id,$3,facility_id,'Other agreement unit' FROM domain.reservable_unit WHERE tenant_id=$1 AND id=$2",
          [tenant, replacementUnit, destinationUnit],
        );
        await migration.query(
          "INSERT INTO domain.unit_calendar_version(tenant_id,unit_id,version,minimum_minutes,maximum_minutes,step_minutes,weekly,exceptions,actor_id,reason) SELECT tenant_id,$3,1,minimum_minutes,maximum_minutes,step_minutes,weekly,exceptions,'citizen','Fixture' FROM domain.unit_calendar_version WHERE tenant_id=$1 AND unit_id=$2 AND version=1",
          [tenant, replacementUnit, destinationUnit],
        );
        await migration.query(
          "UPDATE domain.reservable_unit SET calendar_version=1,published_at=now() WHERE tenant_id=$1 AND id=$2",
          [tenant, destinationUnit],
        );
        const destination = (
          await createAgreementDraft(
            domain,
            admin,
            tenant,
            "destination-agreement",
            {
              ...definition,
              name: "Destination",
              timeZone: "Europe/Madrid",
              weeklyLimit: 1,
              participants: [
                {
                  tenantId: tenant,
                  accreditationIssuer: false,
                  unitIds: [destinationUnit],
                },
              ],
            },
            randomUUID(),
            3600,
          )
        ).result.agreementId;
        await approveAgreement(
          domain,
          admin,
          tenant,
          destination,
          "destination-approval",
          { version: 1, unitIds: [destinationUnit] },
          randomUUID(),
          3600,
        );
        await activateAgreement(
          domain,
          admin,
          tenant,
          destination,
          "destination-activation",
          evidence,
          randomUUID(),
          3600,
        );
        const occupiedQuota = (
          await createReservation(
            domain,
            actor,
            tenant,
            "destination-quota-holder",
            { ...input(winner, 20), unitId: destinationUnit },
            randomUUID(),
            3600,
            clock,
          )
        ).result;
        const movable = (
          await createReservation(
            domain,
            actor,
            tenant,
            "quota-after-cancel",
            { ...input(winner, 21), unitId: replacementUnit },
            randomUUID(),
            3600,
            clock,
          )
        ).result;
        const counts = async () =>
          (
            await migration.query(
              "SELECT agreement_id,count(*)::int AS n FROM domain.agreement_consumption WHERE agreement_id=ANY($1::uuid[]) AND NOT released GROUP BY agreement_id ORDER BY agreement_id",
              [[id, destination]],
            )
          ).rows;
        const before = await counts();
        await assert.rejects(
          modifyReservation(
            domain,
            actor,
            tenant,
            movable.id,
            "move-to-full-destination",
            {
              ...input(winner, 21),
              unitId: destinationUnit,
              expectedRevision: 1,
            },
            randomUUID(),
            3600,
            clock,
          ),
          { code: "CONFLICT" },
        );
        assert.deepEqual(await counts(), before);
        const unchanged = (
          await migration.query(
            "SELECT unit_id,revision FROM domain.reservation WHERE tenant_id=$1 AND id=$2",
            [tenant, movable.id],
          )
        ).rows[0];
        assert.deepEqual(unchanged, { unit_id: replacementUnit, revision: 1 });
        await cancelReservation(
          domain,
          actor,
          tenant,
          occupiedQuota.id,
          "free-destination-quota",
          { expectedRevision: 1 },
          randomUUID(),
          3600,
          clock,
        );
        const moveCorrelation = randomUUID();
        const movedAcross = await modifyReservation(
          domain,
          actor,
          tenant,
          movable.id,
          "move-agreements",
          {
            ...input(winner, 21),
            unitId: destinationUnit,
            expectedRevision: 1,
          },
          moveCorrelation,
          3600,
          clock,
        );
        assert.equal(movedAcross.result.unitId, destinationUnit);
        assert.equal(movedAcross.result.revision, 2);
        const attribution = (
          await migration.query(
            "SELECT agreement_id,released FROM domain.agreement_consumption WHERE tenant_id=$1 AND reservation_id=$2 ORDER BY agreement_id",
            [tenant, movable.id],
          )
        ).rows;
        assert.deepEqual(
          attribution,
          [
            { agreement_id: id, released: true },
            { agreement_id: destination, released: false },
          ].sort((a, b) => a.agreement_id.localeCompare(b.agreement_id)),
        );
        const events = (
          await migration.query(
            "SELECT agreement_id,action FROM domain.agreement_consumption_event WHERE correlation_id=$1 ORDER BY action",
            [moveCorrelation],
          )
        ).rows;
        assert.deepEqual(events, [
          { agreement_id: destination, action: "ATTRIBUTED" },
          { agreement_id: id, action: "RELEASED" },
        ]);
        const afterMove = await counts();
        assert.equal(
          afterMove.find(
            (row: { agreement_id: string }) => row.agreement_id === id,
          ).n,
          2,
        );
        assert.equal(
          afterMove.find(
            (row: { agreement_id: string }) => row.agreement_id === destination,
          ).n,
          1,
        );
        await createReservation(
          domain,
          actor,
          tenant,
          "origin-quota-reused",
          { ...input(winner, 21), unitId: replacementUnit },
          randomUUID(),
          3600,
          clock,
        );
        const binding = await readUnitAgreementRestriction(
          domain,
          admin,
          tenant,
          publicUnit,
        );
        assert.deepEqual(binding.restriction, {
          agreementId: id,
          version: 3,
          hasRemainingAssignment: false,
        });
        const release = (unit: string, version: number, key: string) =>
          releaseUnitAgreementRestriction(
            domain,
            admin,
            tenant,
            unit,
            key,
            {
              expectedAgreementId: id,
              expectedVersion: version,
              reason: "Municipal public access",
            },
            randomUUID(),
            3600,
          );
        await assert.rejects(
          release(publicUnit, 4, "wrong-reopening-version"),
          { code: "CONFLICT" },
        );
        await assert.rejects(release(replacementUnit, 4, "active-reopening"), {
          code: "CONFLICT",
        });
        await assert.rejects(
          readUnitAgreementRestriction(domain, actor, tenant, publicUnit),
          { code: "FORBIDDEN" },
        );
        const preserved = async () =>
          (
            await migration.query(
              "SELECT to_jsonb(u) AS unit FROM domain.reservable_unit u WHERE tenant_id=$1 AND id=$2",
              [tenant, publicUnit],
            )
          ).rows;
        const beforeUnit = await preserved(),
          beforeCounts = await counts();
        const reopened = await release(publicUnit, 3, "reopen-public");
        assert.deepEqual(reopened.result, {
          unitId: publicUnit,
          removed: true,
        });
        assert.equal(
          (await release(publicUnit, 3, "reopen-public")).replayed,
          true,
        );
        assert.equal(
          (await release(publicUnit, 3, "reopen-public-again")).result.removed,
          false,
        );
        assert.equal(
          (
            await readUnitAgreementRestriction(
              domain,
              admin,
              tenant,
              publicUnit,
            )
          ).restriction,
          null,
        );
        assert.deepEqual(await preserved(), beforeUnit);
        assert.deepEqual(await counts(), beforeCounts);
        assert.deepEqual(
          (
            await migration.query(
              "SELECT agreement_id,version,reason FROM domain.unit_agreement_release_event WHERE tenant_id=$1 AND unit_id=$2",
              [tenant, publicUnit],
            )
          ).rows,
          [{ agreement_id: id, version: 3, reason: "Municipal public access" }],
        );
        await createReservation(
          domain,
          actor,
          tenant,
          "public-after-release",
          { ...input(winner, 22), unitId: publicUnit },
          randomUUID(),
          3600,
          clock,
        );
        assert.deepEqual(await counts(), beforeCounts);
        await assert.rejects(
          createReservation(
            domain,
            actor,
            tenant,
            "occupied-after-release",
            { ...input(winner, 22), unitId: publicUnit },
            randomUUID(),
            3600,
            clock,
          ),
          { code: "CONFLICT" },
        );

        await scenario.test(
          "scheduled replacement rolls back conflicts and preserves prior consumption",
          async () => {
            const future = {
              ...definition,
              startsAt: "2035-01-01T00:00:00Z",
              weeklyLimit: 1,
              participants: [
                {
                  tenantId: tenant,
                  accreditationIssuer: false,
                  unitIds: [destinationUnit, replacementUnit],
                },
              ],
            };
            await createAgreementVersion(
              domain,
              admin,
              tenant,
              destination,
              "conflicting-future-version",
              { ...future, expectedVersion: 1 },
              randomUUID(),
              3600,
            );
            await approveAgreement(
              domain,
              admin,
              tenant,
              destination,
              "conflicting-future-approval",
              { version: 2, unitIds: [destinationUnit, replacementUnit] },
              randomUUID(),
              3600,
            );
            const snapshot = async () => {
              const data: Record<string, unknown> = {};
              for (const table of [
                "agreement_activation",
                "agreement_assignment",
                "unit_agreement_gate",
                "agreement_consumption",
                "agreement_consumption_event",
                "agreement_lifecycle_event",
                "agreement_version",
              ]) {
                data[table] = (
                  await migration.query(
                    `SELECT to_jsonb(r) AS row FROM domain.${table} r WHERE agreement_id=ANY($1::uuid[]) ORDER BY to_jsonb(r)::text`,
                    [[id, destination]],
                  )
                ).rows;
              }
              return data;
            };
            const beforeConflict = await snapshot();
            await assert.rejects(
              activateAgreement(
                domain,
                admin,
                tenant,
                destination,
                "conflicting-future-activation",
                { ...evidence, version: 2 },
                randomUUID(),
                3600,
              ),
              { code: "CONFLICT" },
            );
            assert.deepEqual(await snapshot(), beforeConflict);
            assert.equal(
              (
                await migration.query(
                  "SELECT count(*)::int AS n FROM domain.idempotent_command WHERE tenant_id=$1 AND operation='agreement.activate' AND key='conflicting-future-activation'",
                  [tenant],
                )
              ).rows[0].n,
              0,
            );
            const reservationsBefore = (
              await migration.query(
                "SELECT to_jsonb(r) AS row FROM domain.reservation r WHERE tenant_id=$1 ORDER BY id",
                [tenant],
              )
            ).rows;
            const consumptionsBefore = await counts();
            const valid = {
              ...future,
              participants: [
                {
                  tenantId: tenant,
                  accreditationIssuer: false,
                  unitIds: [destinationUnit],
                },
              ],
            };
            await createAgreementVersion(
              domain,
              admin,
              tenant,
              destination,
              "valid-future-version",
              { ...valid, expectedVersion: 2 },
              randomUUID(),
              3600,
            );
            await approveAgreement(
              domain,
              admin,
              tenant,
              destination,
              "valid-future-approval",
              { version: 3, unitIds: [destinationUnit] },
              randomUUID(),
              3600,
            );
            const activateFuture = () =>
              activateAgreement(
                domain,
                admin,
                tenant,
                destination,
                "valid-future-activation",
                { ...evidence, version: 3 },
                randomUUID(),
                3600,
              );
            await activateFuture();
            assert.equal((await activateFuture()).replayed, true);
            const periods = (
              await migration.query(
                "SELECT version,lower(effective_period) AS start,upper(effective_period) AS end FROM domain.agreement_activation WHERE agreement_id=$1 ORDER BY version",
                [destination],
              )
            ).rows;
            assert.deepEqual(
              periods.map((r) => r.version),
              [1, 3],
            );
            assert.equal(
              periods[0].end.toISOString(),
              valid.startsAt.replace("Z", ".000Z"),
            );
            assert.equal(
              periods[1].start.toISOString(),
              periods[0].end.toISOString(),
            );
            assert.equal(
              periods[1].end.toISOString(),
              "2040-01-01T00:00:00.000Z",
            );
            assert.deepEqual(await counts(), consumptionsBefore);
            assert.deepEqual(
              (
                await migration.query(
                  "SELECT to_jsonb(r) AS row FROM domain.reservation r WHERE tenant_id=$1 ORDER BY id",
                  [tenant],
                )
              ).rows,
              reservationsBefore,
            );
            assert.equal(
              (
                await migration.query(
                  "SELECT count(*)::int AS n FROM domain.agreement_consumption WHERE agreement_id=$1 AND attribution_version=1 AND NOT released",
                  [destination],
                )
              ).rows[0].n,
              1,
            );
            await createAgreementVersion(
              domain,
              admin,
              tenant,
              destination,
              "earlier-future-version",
              {
                ...valid,
                startsAt: "2034-01-01T00:00:00Z",
                expectedVersion: 3,
              },
              randomUUID(),
              3600,
            );
            await approveAgreement(
              domain,
              admin,
              tenant,
              destination,
              "earlier-future-approval",
              { version: 4, unitIds: [destinationUnit] },
              randomUUID(),
              3600,
            );
            await activateAgreement(
              domain,
              admin,
              tenant,
              destination,
              "earlier-future-activation",
              { ...evidence, version: 4 },
              randomUUID(),
              3600,
            );
            const replaced = (
              await migration.query(
                "SELECT version,isempty(effective_period) AS empty,upper(effective_period) AS end FROM domain.agreement_activation WHERE agreement_id=$1 ORDER BY version",
                [destination],
              )
            ).rows;
            assert.equal(
              replaced[0].end.toISOString(),
              "2034-01-01T00:00:00.000Z",
            );
            assert.equal(replaced[1].empty, true);
            assert.equal(replaced[2].empty, false);
            assert.equal(
              (
                await migration.query(
                  "SELECT isempty(effective_period) AS empty FROM domain.agreement_assignment WHERE agreement_id=$1 AND version=3",
                  [destination],
                )
              ).rows[0].empty,
              true,
            );
            assert.equal(
              (
                await migration.query(
                  "SELECT version FROM domain.unit_agreement_gate WHERE tenant_id=$1 AND unit_id=$2",
                  [tenant, destinationUnit],
                )
              ).rows[0].version,
              4,
            );
            assert.deepEqual(await counts(), consumptionsBefore);
          },
        );

        await scenario.test(
          "reassignment, quota toggles and concurrent lifecycle changes preserve consumptions",
          async () => {
            const successor = (
              await createAgreementDraft(
                domain,
                admin,
                tenant,
                "successor-agreement",
                {
                  ...definition,
                  name: "Successor",
                  timeZone: "Europe/Madrid",
                  weeklyLimit: 1,
                  participants: [
                    {
                      tenantId: tenant,
                      accreditationIssuer: false,
                      unitIds: [publicUnit],
                    },
                  ],
                },
                randomUUID(),
                3600,
              )
            ).result.agreementId;
            await approveAgreement(
              domain,
              admin,
              tenant,
              successor,
              "successor-approval",
              { version: 1, unitIds: [publicUnit] },
              randomUUID(),
              3600,
            );
            const formerCounts = await counts();
            await activateAgreement(
              domain,
              admin,
              tenant,
              successor,
              "successor-activation",
              evidence,
              randomUUID(),
              3600,
            );
            assert.deepEqual(await counts(), formerCounts);
            const retained = prior[1];
            assert.ok(retained);
            const attributions = async () =>
              (
                await migration.query(
                  "SELECT agreement_id,released FROM domain.agreement_consumption WHERE tenant_id=$1 AND reservation_id=$2 ORDER BY agreement_id",
                  [tenant, retained.id],
                )
              ).rows;
            const expected = [id, successor]
              .sort()
              .map((agreement_id) => ({ agreement_id, released: false }));
            assert.deepEqual(await attributions(), expected);
            await modifyReservation(
              domain,
              actor,
              tenant,
              retained.id,
              "retained-noop",
              { ...input(winner, 19), unitId: publicUnit, expectedRevision: 1 },
              randomUUID(),
              3600,
              clock,
            );
            assert.deepEqual(await attributions(), expected);
            await assert.rejects(
              createReservation(
                domain,
                actor,
                tenant,
                "successor-excess-quota",
                { ...input(winner, 21), unitId: publicUnit },
                randomUUID(),
                3600,
                clock,
              ),
              { code: "CONFLICT" },
            );
            const correlation = randomUUID();
            await cancelReservation(
              domain,
              actor,
              tenant,
              retained.id,
              "cancel-retained-consumptions",
              { expectedRevision: 1 },
              correlation,
              3600,
              clock,
            );
            assert.deepEqual(
              await attributions(),
              expected.map((row) => ({ ...row, released: true })),
            );
            assert.deepEqual(
              (
                await migration.query(
                  "SELECT agreement_id,action FROM domain.agreement_consumption_event WHERE correlation_id=$1 ORDER BY agreement_id",
                  [correlation],
                )
              ).rows,
              [id, successor]
                .sort()
                .map((agreement_id) => ({ agreement_id, action: "RELEASED" })),
            );
            await assert.rejects(
              domain.query("SELECT * FROM domain.agreement_consumption"),
              { code: "42501" },
            );
            const changeLimit = async (
              expectedVersion: number,
              weeklyLimit: number | null,
            ) => {
              const version = expectedVersion + 1;
              await createAgreementVersion(
                domain,
                admin,
                tenant,
                successor,
                `limit-version-${version}`,
                {
                  ...definition,
                  expectedVersion,
                  weeklyLimit,
                  participants: [
                    {
                      tenantId: tenant,
                      accreditationIssuer: false,
                      unitIds: [publicUnit],
                    },
                  ],
                },
                randomUUID(),
                3600,
              );
              await approveAgreement(
                domain,
                admin,
                tenant,
                successor,
                `limit-approval-${version}`,
                { version, unitIds: [publicUnit] },
                randomUUID(),
                3600,
              );
              await activateAgreement(
                domain,
                admin,
                tenant,
                successor,
                `limit-activation-${version}`,
                { ...evidence, version },
                randomUUID(),
                3600,
              );
            };
            const activeConsumption = async () =>
              (
                await migration.query(
                  "SELECT reservation_id,subject_id,starts_at,ends_at,week_start FROM domain.agreement_consumption WHERE agreement_id=$1 AND NOT released ORDER BY reservation_id",
                  [successor],
                )
              ).rows;
            const beforeDisable = await activeConsumption();
            await changeLimit(1, null);
            assert.deepEqual(await activeConsumption(), beforeDisable);
            const extra = (
              await createReservation(
                domain,
                actor,
                tenant,
                "quota-disabled-booking",
                { ...input(winner, 21), unitId: publicUnit },
                randomUUID(),
                3600,
                clock,
              )
            ).result;
            const beforeEnable = await activeConsumption();
            assert.equal(beforeEnable.length, beforeDisable.length + 1);
            await changeLimit(2, 1);
            assert.deepEqual(await activeConsumption(), beforeEnable);
            await assert.rejects(
              createReservation(
                domain,
                actor,
                tenant,
                "quota-restored-excess",
                { ...input(winner, 18), unitId: publicUnit },
                randomUUID(),
                3600,
                clock,
              ),
              { code: "CONFLICT" },
            );
            await cancelReservation(
              domain,
              actor,
              tenant,
              extra.id,
              "cancel-unlimited-consumption",
              { expectedRevision: 1 },
              randomUUID(),
              3600,
              clock,
            );
            await assert.rejects(
              createReservation(
                domain,
                actor,
                tenant,
                "quota-still-full",
                { ...input(winner, 18), unitId: publicUnit },
                randomUUID(),
                3600,
                clock,
              ),
              { code: "CONFLICT" },
            );
            assert.equal(
              (await activeConsumption()).length,
              beforeDisable.length,
            );

            await createAgreementVersion(
              domain,
              admin,
              tenant,
              successor,
              "racing-version",
              {
                ...definition,
                expectedVersion: 3,
                weeklyLimit: 2,
                participants: [
                  {
                    tenantId: tenant,
                    accreditationIssuer: false,
                    unitIds: [publicUnit],
                  },
                ],
              },
              randomUUID(),
              3600,
            );
            await approveAgreement(
              domain,
              admin,
              tenant,
              successor,
              "racing-approval",
              { version: 4, unitIds: [publicUnit] },
              randomUUID(),
              3600,
            );
            const beforeRace = await activeConsumption();
            const race = await Promise.all([
              activateAgreement(
                domain,
                admin,
                tenant,
                successor,
                "racing-activation",
                { ...evidence, version: 4 },
                randomUUID(),
                3600,
              ),
              suspendAgreement(
                domain,
                admin,
                tenant,
                successor,
                "racing-suspension",
                { version: 3, reason: "Concurrent lifecycle review" },
                randomUUID(),
                3600,
              ),
            ]);
            assert.equal(race[0].result.status, "ACTIVADO");
            assert.equal(race[1].result.status, "SUSPENDIDO");
            const state = (
              await migration.query(
                "SELECT v.status,a.effective_period @> clock_timestamp() AS effective FROM domain.agreement_version v JOIN domain.agreement_activation a USING(agreement_id,version) WHERE v.agreement_id=$1 AND v.version=4",
                [successor],
              )
            ).rows[0];
            assert.ok(["ACTIVADO", "SUSPENDIDO"].includes(state.status));
            assert.equal(state.effective, state.status === "ACTIVADO");
            assert.equal(
              (
                await migration.query(
                  "SELECT count(*)::int AS n FROM domain.agreement_activation WHERE agreement_id=$1 AND effective_period @> clock_timestamp()",
                  [successor],
                )
              ).rows[0].n,
              state.effective ? 1 : 0,
            );
            assert.equal(
              (
                await migration.query(
                  "SELECT count(*)::int AS n FROM domain.agreement_lifecycle_event WHERE agreement_id=$1 AND version=3 AND action='SUSPENDED'",
                  [successor],
                )
              ).rows[0].n,
              1,
            );
            assert.equal(
              (
                await migration.query(
                  "SELECT count(*)::int AS n FROM domain.agreement_lifecycle_event WHERE agreement_id=$1 AND version=4 AND action='ACTIVATED'",
                  [successor],
                )
              ).rows[0].n,
              1,
            );
            assert.deepEqual(await activeConsumption(), beforeRace);
            assert.equal(
              (
                await migration.query(
                  "SELECT version FROM domain.unit_agreement_gate WHERE tenant_id=$1 AND unit_id=$2",
                  [tenant, publicUnit],
                )
              ).rows[0].version,
              4,
            );
          },
        );
      },
    );
  });
});
