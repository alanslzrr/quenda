import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { initializeOperator } from "../../scripts/lib/initialize-operator.ts";
import { transaction } from "../../src/database/transaction.ts";
import {
  readBookingPolicy,
  saveBookingPolicy,
} from "../../src/modules/identity/booking-policy.ts";
import {
  acceptAdministratorInvitation,
  createMunicipality,
} from "../../src/modules/identity/index.ts";
import {
  cancelReservation,
  createReservation,
} from "../../src/modules/reservations/index.ts";
import { withDatabase } from "../helpers/postgres.ts";
import { seedUsageRules } from "../helpers/usage-rules-fixture.ts";

test("municipal booking policy is versioned, scoped and audited atomically", {
  timeout: 60000,
}, async () => {
  await withDatabase(async ({ domain, auth, migration, worker }) => {
    const actor = (id: string) => ({
      accountId: id,
      email: `${id}@example.test`,
      sessionId: id,
      mfaVerifiedAt: new Date(),
    });
    for (const id of ["operator", "administrator", "outsider"])
      await auth.query(
        'INSERT INTO auth."user"(id,name,email,"emailVerified","createdAt","updatedAt","twoFactorEnabled") VALUES($1,$1,$2,true,now(),now(),true)',
        [id, `${id}@example.test`],
      );
    const owner = await migration.connect();
    try {
      await initializeOperator(owner, "operator");
    } finally {
      owner.release();
    }
    const { tenantId, invitationId } = await createMunicipality(
      domain,
      actor("operator"),
      {
        name: "Policy test",
        timezone: "Europe/Madrid",
        administratorId: "administrator",
        invitationExpiresAt: new Date(Date.now() + 3600000).toISOString(),
      },
    );
    const admin = actor("administrator");
    await acceptAdministratorInvitation(domain, admin, tenantId, invitationId);
    const input = {
      expectedVersion: 1,
      advanceDays: 15,
      cancellationMinutes: 60,
      reason: " Policy adjustment ",
    };
    const save = (body = input) =>
      saveBookingPolicy(domain, admin, tenantId, body, randomUUID());
    assert.deepEqual(await readBookingPolicy(domain, admin, tenantId), {
      tenantId,
      version: 1,
      advanceDays: 30,
      cancellationMinutes: 1440,
    });
    for (const who of [
      actor("operator"),
      actor("outsider"),
      { ...admin, mfaVerifiedAt: null },
    ]) {
      await assert.rejects(
        saveBookingPolicy(domain, who, tenantId, input, randomUUID()),
      );
      await assert.rejects(readBookingPolicy(domain, who, tenantId));
    }
    await assert.rejects(
      saveBookingPolicy(domain, admin, randomUUID(), input, randomUUID()),
      { code: "FORBIDDEN" },
    );
    for (const invalid of [
      { ...input, advanceDays: -1 },
      { ...input, cancellationMinutes: 0.5 },
      { ...input, reason: " " },
      { ...input, expectedVersion: 2147483647 },
    ])
      await assert.rejects(save(invalid), { code: "INVALID_INPUT" });
    const competing = await Promise.allSettled([
      save(),
      save({ ...input, advanceDays: 20 }),
    ]);
    assert.equal(competing.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(
      competing.filter(
        (r) => r.status === "rejected" && r.reason.code === "CONFLICT",
      ).length,
      1,
    );
    const current = await readBookingPolicy(domain, admin, tenantId);
    assert.equal(current.version, 2);
    const events = (
      await migration.query(
        "SELECT * FROM domain.municipal_booking_policy_event WHERE tenant_id=$1",
        [tenantId],
      )
    ).rows;
    assert.equal(events.length, 1);
    assert.equal(events[0].actor_id, admin.accountId);
    assert.equal(events[0].previous_advance_days, 30);
    assert.equal(events[0].advance_days, current.advanceDays);
    assert.equal(events[0].reason, "Policy adjustment");
    for (const pool of [domain, auth, worker])
      await assert.rejects(
        pool.query("SELECT * FROM domain.municipal_booking_policy_event"),
        { code: "42501" },
      );
    await assert.rejects(
      domain.query(
        "UPDATE domain.municipality SET advance_days=0 WHERE id=$1",
        [tenantId],
      ),
      { code: "42501" },
    );
    await assert.rejects(
      domain.query(
        "SELECT domain.save_municipal_booking_policy(2,0,0,'Missing context',$1)",
        [randomUUID()],
      ),
      { code: "42501" },
    );
    await migration.query(
      `CREATE FUNCTION domain.reject_policy_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic audit failure'; END $$; CREATE TRIGGER reject_policy_audit BEFORE INSERT ON domain.municipal_booking_policy_event FOR EACH ROW EXECUTE FUNCTION domain.reject_policy_audit()`,
    );
    try {
      await assert.rejects(
        save({ ...input, expectedVersion: 2, advanceDays: 0 }),
      );
      assert.deepEqual(
        await readBookingPolicy(domain, admin, tenantId),
        current,
      );
    } finally {
      await migration.query(
        "DROP TRIGGER reject_policy_audit ON domain.municipal_booking_policy_event; DROP FUNCTION domain.reject_policy_audit()",
      );
    }
    const unit = randomUUID();
    await transaction(migration, async (client) => {
      const facility = randomUUID();
      await client.query(
        "INSERT INTO domain.facility(tenant_id,id,name,published_at) VALUES($1,$2,'Fixture',now())",
        [tenantId, facility],
      );
      await client.query(
        "INSERT INTO domain.reservable_unit(tenant_id,id,facility_id,name) VALUES($1,$2,$3,'Fixture')",
        [tenantId, unit, facility],
      );
      await client.query(
        "INSERT INTO domain.unit_calendar_version(tenant_id,unit_id,version,minimum_minutes,maximum_minutes,step_minutes,advance_days,weekly,exceptions,actor_id,reason) VALUES($1,$2,1,60,60,60,10,$3,'[]','administrator','Fixture')",
        [
          tenantId,
          unit,
          JSON.stringify(
            Array.from({ length: 7 }, (_, i) => ({
              day: i + 1,
              startMinute: 0,
              endMinute: 1440,
            })),
          ),
        ],
      );
      await seedUsageRules(client, tenantId, unit, "administrator");
      await client.query(
        "UPDATE domain.reservable_unit SET calendar_version=1,published_at=now() WHERE tenant_id=$1 AND id=$2",
        [tenantId, unit],
      );
    });
    await assert.rejects(
      save({ ...input, expectedVersion: 2, advanceDays: 5 }),
      { code: "CONFLICT" },
    );
    assert.deepEqual(await readBookingPolicy(domain, admin, tenantId), current);
    const clock = { now: () => new Date("2030-01-01T12:00:00Z") };
    const book = (hour: number, version: number, nonCancellable = false) =>
      createReservation(
        domain,
        admin,
        tenantId,
        `policy-book-${hour}`,
        {
          acceptance: {
            usageRulesVersion: 1,
            bookingPolicyVersion: version,
            nonCancellable,
          },
          unitId: unit,
          startsAt: `2030-01-02T${hour}:00:00Z`,
          endsAt: `2030-01-02T${hour + 1}:00:00Z`,
        },
        randomUUID(),
        3600,
        clock,
      );
    const old = await book(10, 2);
    assert.equal(old.result.cancellationMinutes, 60);
    await save({
      ...input,
      expectedVersion: 2,
      advanceDays: 10,
      cancellationMinutes: 1440,
    });
    const fresh = await book(11, 3, true);
    assert.equal(fresh.result.cancellationMinutes, 1440);
    const cancel = (id: string) =>
      cancelReservation(
        domain,
        admin,
        tenantId,
        id,
        `cancel-${id}`,
        { expectedRevision: 1 },
        randomUUID(),
        3600,
        clock,
      );
    assert.equal((await cancel(old.result.id)).result.status, "CANCELADA");
    await assert.rejects(cancel(fresh.result.id), {
      code: "RESERVATION_DEADLINE_PASSED",
    });
    await assert.rejects(
      createReservation(
        domain,
        admin,
        tenantId,
        "beyond-policy",
        {
          acceptance: {
            usageRulesVersion: 1,
            bookingPolicyVersion: 3,
            nonCancellable: false,
          },
          unitId: unit,
          startsAt: "2030-01-12T10:00:00Z",
          endsAt: "2030-01-12T11:00:00Z",
        },
        randomUUID(),
        3600,
        clock,
      ),
      { code: "CONFLICT" },
    );
  });
});
