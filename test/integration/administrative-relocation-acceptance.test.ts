import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { Client, type Pool } from "pg";
import { buildApp } from "../../src/app.ts";
import { transaction } from "../../src/database/transaction.ts";
import { publicAvailability } from "../../src/modules/catalog/index.ts";
import { createAuthentication } from "../../src/modules/identity/index.ts";
import {
  acceptReservationUsageRules,
  cancelReservation,
  createReservation,
  modifyReservation,
  readReservation,
} from "../../src/modules/reservations/index.ts";
import { browser } from "../helpers/auth-client.ts";
import { withDatabase } from "../helpers/postgres.ts";
import { recoveryFixture } from "../helpers/recovery-fixture.ts";
import { verifyProductResponses } from "../helpers/response-contract.ts";
import {
  initialAcceptance,
  seedUsageRules,
} from "../helpers/usage-rules-fixture.ts";

async function fixture(auth: Pool, migration: Pool) {
  const { tenants, units, agreement } = await recoveryFixture(auth, migration);
  const tenant = tenants[0],
    source = units[0],
    destination = randomUUID();
  for (const account of ["relocation-admin", "other-holder"])
    await auth.query(
      'INSERT INTO auth."user"(id,name,email,"emailVerified") VALUES($1,$1,$2,true)',
      [account, `${account}@example.test`],
    );
  await auth.query(
    'UPDATE auth."user" SET "twoFactorEnabled"=true WHERE id=\'relocation-admin\'',
  );
  const invitation = randomUUID();
  await migration.query(
    "INSERT INTO domain.municipal_profile(tenant_id,account_id) VALUES($1,'relocation-admin')",
    [tenant],
  );
  await migration.query(
    "INSERT INTO domain.administrator_invitation(tenant_id,id,account_id,invited_by,expires_at,accepted_at) VALUES($1,$2,'relocation-admin','relocation-admin',now()+interval '1 day',now())",
    [tenant, invitation],
  );
  await migration.query(
    "INSERT INTO domain.municipal_administrator(tenant_id,account_id,invitation_id) VALUES($1,'relocation-admin',$2)",
    [tenant, invitation],
  );
  await migration.query(
    "UPDATE domain.municipality SET cancellation_minutes=1440 WHERE id=$1",
    [tenant],
  );
  await migration.query(
    "INSERT INTO domain.reservable_unit(tenant_id,id,facility_id,name) SELECT tenant_id,$3,facility_id,'Relocation destination' FROM domain.reservable_unit WHERE tenant_id=$1 AND id=$2",
    [tenant, source, destination],
  );
  await migration.query(
    "INSERT INTO domain.unit_calendar_version(tenant_id,unit_id,version,minimum_minutes,maximum_minutes,step_minutes,weekly,exceptions,actor_id,reason) SELECT tenant_id,$3,1,minimum_minutes,maximum_minutes,step_minutes,weekly,exceptions,actor_id,'Relocation fixture' FROM domain.unit_calendar_version WHERE tenant_id=$1 AND unit_id=$2 AND version=1",
    [tenant, source, destination],
  );
  await seedUsageRules(migration, tenant, destination, "relocation-admin");
  await migration.query(
    "UPDATE domain.reservable_unit SET calendar_version=1,published_at=now() WHERE tenant_id=$1 AND id=$2",
    [tenant, destination],
  );
  await migration.query(
    "INSERT INTO domain.agreement_unit VALUES($1,1,$2,$3)",
    [agreement, tenant, destination],
  );
  await migration.query(
    "INSERT INTO domain.agreement_assignment VALUES($1,1,$2,$3,'[2020-01-01T00:00:00Z,2040-01-01T00:00:00Z)')",
    [agreement, tenant, destination],
  );
  await migration.query(
    "INSERT INTO domain.unit_agreement_gate VALUES($1,$2,$3,1)",
    [tenant, destination, agreement],
  );
  const holder = {
    accountId: "citizen",
    email: "citizen@example.test",
    sessionId: "holder-session",
    mfaVerifiedAt: null,
  };
  const admin = {
    accountId: "relocation-admin",
    email: "relocation-admin@example.test",
    sessionId: "admin-session",
    mfaVerifiedAt: new Date(),
  };
  return {
    tenant,
    source,
    destination,
    agreement,
    tenants,
    units,
    holder,
    admin,
  };
}

async function physicalState(migration: Pool, reservationId: string) {
  return {
    occupancy: (
      await migration.query(
        "SELECT * FROM domain.occupancy WHERE reservation_id=$1 ORDER BY id",
        [reservationId],
      )
    ).rows,
    consumption: (
      await migration.query(
        "SELECT c.*,c.week_start::text AS week_start FROM domain.agreement_consumption c WHERE reservation_id=$1 ORDER BY agreement_id",
        [reservationId],
      )
    ).rows,
    consumptionEvents: (
      await migration.query(
        "SELECT * FROM domain.agreement_consumption_event WHERE reservation_id=$1 ORDER BY id",
        [reservationId],
      )
    ).rows,
    notices: (
      await migration.query(
        "SELECT n.* FROM domain.reservation_notice n JOIN domain.reservation_event e ON (e.tenant_id,e.id)=(n.tenant_id,n.event_id) WHERE e.reservation_id=$1 ORDER BY n.event_id",
        [reservationId],
      )
    ).rows,
    emails: (
      await migration.query(
        "SELECT n.* FROM domain.reservation_email n JOIN domain.reservation_event e ON (e.tenant_id,e.id)=(n.tenant_id,n.event_id) WHERE e.reservation_id=$1 ORDER BY n.event_id",
        [reservationId],
      )
    ).rows,
  };
}

test("administrative relocation commits occupancy and quota immediately, then accepts only the exact pending norms", {
  timeout: 60000,
}, async () => {
  await withDatabase(async ({ auth, migration, domain }) => {
    const f = await fixture(auth, migration);
    let now = "2030-01-01T00:00:00Z";
    const clock = { now: () => new Date(now) };
    const original = {
      unitId: f.source,
      startsAt: "2030-01-02T10:00:00Z",
      endsAt: "2030-01-02T11:00:00Z",
    };
    const created = (
      await createReservation(
        domain,
        f.holder,
        f.tenant,
        "create",
        { ...original, acceptance: initialAcceptance },
        randomUUID(),
        3600,
        clock,
      )
    ).result;
    assert.equal(created.usageRulesUnitId, f.source);
    assert.equal(created.pendingUsageRulesVersion, null);
    await migration.query(
      "UPDATE domain.municipality SET cancellation_minutes=0,booking_policy_version=2 WHERE id=$1",
      [f.tenant],
    );
    now = "2030-01-02T09:30:00Z";
    const target = {
      unitId: f.destination,
      startsAt: "2030-01-08T10:00:00Z",
      endsAt: "2030-01-08T11:00:00Z",
      expectedRevision: 1,
      administrative: true,
      reason: "Maintenance at the original unit",
    };
    const moved = (
      await modifyReservation(
        domain,
        f.admin,
        f.tenant,
        created.id,
        "relocate",
        target,
        randomUUID(),
        3600,
        clock,
      )
    ).result;
    assert.equal(moved.status, "CONFIRMADA");
    assert.equal(moved.unitId, f.destination);
    assert.equal(moved.revision, 2);
    assert.equal(moved.usageRulesUnitId, f.source);
    assert.equal(moved.usageRulesVersion, 1);
    assert.equal(moved.rulesAcceptedAt, created.rulesAcceptedAt);
    assert.equal(moved.pendingUsageRulesVersion, 1);
    for (const field of [
      "cancellationMinutes",
      "bookingPolicyVersion",
      "conditionsAcceptedAt",
      "nonCancellableAccepted",
    ] as const)
      assert.equal(moved[field], created[field], field);
    const slots = async (unit: string, date: string) =>
      (
        await publicAvailability(domain, f.tenant, unit, date, 60, clock)
      ).slots.map((s) => s.start.utc);
    assert.ok(
      (await slots(f.source, "2030-01-02")).includes(
        "2030-01-02T10:00:00.000Z",
      ),
    );
    assert.ok(
      !(await slots(f.destination, "2030-01-08")).includes(
        "2030-01-08T10:00:00.000Z",
      ),
    );
    const physical = await physicalState(migration, created.id);
    assert.equal(physical.consumption.length, 1);
    assert.equal(physical.consumption[0].unit_id, f.destination);
    assert.equal(physical.consumption[0].week_start, "2030-01-07");
    assert.equal(physical.consumption[0].released, false);
    await assert.rejects(
      createReservation(
        domain,
        f.holder,
        f.tenants[1],
        "shared-quota",
        {
          unitId: f.units[1],
          startsAt: "2030-01-08T12:00:00Z",
          endsAt: "2030-01-08T13:00:00Z",
          acceptance: initialAcceptance,
        },
        randomUUID(),
        3600,
        clock,
      ),
      { code: "QUOTA_EXCEEDED" },
    );
    const noop = await modifyReservation(
      domain,
      f.admin,
      f.tenant,
      created.id,
      "no-change",
      { ...target, expectedRevision: 2 },
      randomUUID(),
      3600,
      clock,
    );
    assert.deepEqual(noop.result, moved);
    assert.deepEqual(await physicalState(migration, created.id), physical);
    await assert.rejects(
      modifyReservation(
        domain,
        f.admin,
        f.tenant,
        created.id,
        "admin-cannot-accept-noop",
        {
          ...target,
          expectedRevision: 2,
          acceptance: initialAcceptance,
        },
        randomUUID(),
        3600,
        clock,
      ),
      { code: "HOLDER_ACCEPTANCE_REQUIRED" },
    );
    assert.deepEqual(await physicalState(migration, created.id), physical);
    await migration.query(
      "INSERT INTO domain.unit_usage_rules(tenant_id,unit_id,version,text_content,actor_id,reason,correlation_id) VALUES($1,$2,2,'Later rules do not change a pending agreement','relocation-admin','Later revision',$3)",
      [f.tenant, f.destination, randomUUID()],
    );
    await migration.query(
      "UPDATE domain.reservable_unit SET usage_rules_version=2 WHERE tenant_id=$1 AND id=$2",
      [f.tenant, f.destination],
    );
    now = "2030-01-08T09:30:00Z";
    const pending: {
      expectedRevision: number;
      unitId: string;
      usageRulesVersion: number;
    } = {
      expectedRevision: 2,
      unitId: f.destination,
      usageRulesVersion: 1,
    };
    const accept = (
      key: string,
      input = pending,
      actor: typeof f.holder | typeof f.admin = f.holder,
    ) =>
      acceptReservationUsageRules(
        domain,
        actor,
        f.tenant,
        created.id,
        key,
        input,
        randomUUID(),
        3600,
        clock,
      );
    await assert.rejects(accept("admin-cannot-accept", pending, f.admin), {
      code: "FORBIDDEN",
    });
    await assert.rejects(
      accept("wrong-unit", { ...pending, unitId: f.source }),
      { code: "CONDITIONS_CHANGED" },
    );
    await assert.rejects(
      accept("wrong-version", { ...pending, usageRulesVersion: 2 }),
      { code: "CONDITIONS_CHANGED" },
    );
    await assert.rejects(
      accept("wrong-revision", { ...pending, expectedRevision: 1 }),
      { code: "RESERVATION_CHANGED" },
    );
    assert.deepEqual(await physicalState(migration, created.id), physical);
    const accepted = await accept("accept-pending");
    assert.equal(accepted.result.revision, 3);
    assert.equal(accepted.result.usageRulesUnitId, f.destination);
    assert.equal(accepted.result.usageRulesVersion, 1);
    assert.equal(accepted.result.pendingUsageRulesVersion, null);
    assert.ok(accepted.result.rulesAcceptedAt);
    for (const field of [
      "unitId",
      "startsAt",
      "endsAt",
      "status",
      "cancellationMinutes",
      "bookingPolicyVersion",
      "conditionsAcceptedAt",
      "nonCancellableAccepted",
    ] as const)
      assert.equal(accepted.result[field], moved[field], field);
    assert.deepEqual(await physicalState(migration, created.id), physical);
    const replay = await accept("accept-pending");
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.result, accepted.result);
    const again = await accept("already-accepted", {
      ...pending,
      expectedRevision: 3,
    });
    assert.deepEqual(again.result, accepted.result);
    const events = (
      await migration.query(
        "SELECT revision,kind,actor_id,administrative,before_state,after_state FROM domain.reservation_event WHERE reservation_id=$1 ORDER BY revision",
        [created.id],
      )
    ).rows;
    assert.equal(events.length, 3);
    assert.equal(events[1].actor_id, f.admin.accountId);
    assert.equal(events[1].administrative, true);
    assert.equal(events[1].after_state.pendingUsageRulesVersion, 1);
    assert.equal(events[2].actor_id, f.holder.accountId);
    assert.equal(events[2].kind, "NORMAS_ACEPTADAS");
    assert.equal(events[2].administrative, false);
    assert.equal(events[2].before_state.usageRulesUnitId, f.source);
    assert.equal(events[2].after_state.usageRulesUnitId, f.destination);
  });
});

test("legacy relocation preserves absent evidence and consent never fabricates accepted booking policy", {
  timeout: 60000,
}, async () => {
  await withDatabase(async ({ auth, migration, domain }) => {
    const f = await fixture(auth, migration);
    const reservationId = randomUUID();
    await transaction(migration, async (client) => {
      await client.query(
        "INSERT INTO domain.municipal_profile(tenant_id,account_id) VALUES($1,'citizen')",
        [f.tenant],
      );
      await client.query(
        "INSERT INTO domain.reservation(tenant_id,id,account_id,unit_id,calendar_version,starts_at,ends_at,cancellation_minutes,timezone) VALUES($1,$2,'citizen',$3,1,'2030-01-02T10:00:00Z','2030-01-02T11:00:00Z',0,'Europe/Madrid')",
        [f.tenant, reservationId, f.source],
      );
      await client.query(
        "INSERT INTO domain.occupancy(tenant_id,id,unit_id,reservation_id,period) VALUES($1,$2,$3,$4,'[2030-01-02T10:00:00Z,2030-01-02T11:00:00Z)')",
        [f.tenant, randomUUID(), f.source, reservationId],
      );
      await client.query(
        "SELECT set_config('quenda.account_id','citizen',true),set_config('quenda.tenant_id',$1,true)",
        [f.tenant],
      );
      await client.query(
        "SELECT domain.append_reservation_event($1,$2,$3,NULL)",
        [reservationId, randomUUID(), randomUUID()],
      );
    });
    let now = "2030-01-02T09:30:00Z";
    const clock = { now: () => new Date(now) };
    const moved = (
      await modifyReservation(
        domain,
        f.admin,
        f.tenant,
        reservationId,
        "relocate-legacy",
        {
          unitId: f.destination,
          startsAt: "2030-01-02T11:00:00Z",
          endsAt: "2030-01-02T12:00:00Z",
          expectedRevision: 1,
          administrative: true,
          reason: "Historical reservation relocation",
        },
        randomUUID(),
        3600,
        clock,
      )
    ).result;
    for (const field of [
      "usageRulesUnitId",
      "usageRulesVersion",
      "rulesAcceptedAt",
      "bookingPolicyVersion",
      "conditionsAcceptedAt",
      "nonCancellableAccepted",
    ] as const)
      assert.equal(moved[field], null, field);
    assert.equal(moved.cancellationMinutes, 0);
    assert.equal(moved.pendingUsageRulesVersion, 1);
    const physical = await physicalState(migration, reservationId);
    now = "2030-01-02T10:59:59Z";
    const accepted = (
      await acceptReservationUsageRules(
        domain,
        f.holder,
        f.tenant,
        reservationId,
        "legacy-accept",
        {
          expectedRevision: 2,
          unitId: f.destination,
          usageRulesVersion: 1,
        },
        randomUUID(),
        3600,
        clock,
      )
    ).result;
    assert.equal(accepted.usageRulesUnitId, f.destination);
    assert.equal(accepted.usageRulesVersion, 1);
    assert.ok(accepted.rulesAcceptedAt);
    assert.equal(accepted.pendingUsageRulesVersion, null);
    assert.equal(accepted.cancellationMinutes, 0);
    assert.equal(accepted.bookingPolicyVersion, null);
    assert.equal(accepted.conditionsAcceptedAt, null);
    assert.equal(accepted.nonCancellableAccepted, null);
    assert.deepEqual(await physicalState(migration, reservationId), physical);
    const old = (
      await migration.query(
        "SELECT after_state FROM domain.reservation_event WHERE reservation_id=$1 AND revision=1",
        [reservationId],
      )
    ).rows[0].after_state;
    assert.equal(old.rulesAcceptedAt, null);
    assert.equal(old.usageRulesVersion, null);
  });
});

test("pending acceptance never expires or transfers authority, and cancellation does not require it", {
  timeout: 60000,
}, async () => {
  await withDatabase(async ({ auth, migration, domain }) => {
    const f = await fixture(auth, migration);
    let now = "2030-01-01T00:00:00Z";
    const clock = { now: () => new Date(now) };
    const created = (
      await createReservation(
        domain,
        f.holder,
        f.tenant,
        "pending-create",
        {
          unitId: f.source,
          startsAt: "2030-01-02T10:00:00Z",
          endsAt: "2030-01-02T11:00:00Z",
          acceptance: initialAcceptance,
        },
        randomUUID(),
        3600,
        clock,
      )
    ).result;
    const target = {
      unitId: f.destination,
      startsAt: "2030-01-02T12:00:00Z",
      endsAt: "2030-01-02T13:00:00Z",
    };
    now = "2030-01-02T09:30:00Z";
    await modifyReservation(
      domain,
      f.admin,
      f.tenant,
      created.id,
      "pending-move",
      {
        ...target,
        expectedRevision: 1,
        administrative: true,
        reason: "Relocation",
      },
      randomUUID(),
      3600,
      clock,
    );
    await assert.rejects(
      modifyReservation(
        domain,
        f.holder,
        f.tenant,
        created.id,
        "holder-without-acceptance",
        {
          ...target,
          startsAt: "2030-01-02T14:00:00Z",
          endsAt: "2030-01-02T15:00:00Z",
          expectedRevision: 2,
        },
        randomUUID(),
        3600,
        clock,
      ),
      { code: "RESERVATION_DEADLINE_PASSED" },
    );
    const before = await physicalState(migration, created.id);
    now = "2030-01-02T12:00:00Z";
    await assert.rejects(
      acceptReservationUsageRules(
        domain,
        f.holder,
        f.tenant,
        created.id,
        "after-start",
        {
          expectedRevision: 2,
          unitId: f.destination,
          usageRulesVersion: 1,
        },
        randomUUID(),
        3600,
        clock,
      ),
      { code: "RESERVATION_DEADLINE_PASSED" },
    );
    const finished = await readReservation(
      domain,
      f.holder,
      f.tenant,
      created.id,
      {
        now: () => new Date("2030-01-02T14:00:00Z"),
      },
    );
    assert.equal(finished.pendingUsageRulesVersion, 1);
    assert.equal(finished.status, "FINALIZADA");
    assert.deepEqual(await physicalState(migration, created.id), before);
    now = "2030-01-02T11:30:00Z";
    await assert.rejects(
      cancelReservation(
        domain,
        f.holder,
        f.tenant,
        created.id,
        "late-cancel",
        { expectedRevision: 2 },
        randomUUID(),
        3600,
        clock,
      ),
      { code: "RESERVATION_DEADLINE_PASSED" },
    );
    assert.deepEqual(await physicalState(migration, created.id), before);
    const cancelled = (
      await cancelReservation(
        domain,
        f.admin,
        f.tenant,
        created.id,
        "cancel-pending",
        {
          expectedRevision: 2,
          administrative: true,
          reason: "Holder contacted the municipality",
        },
        randomUUID(),
        3600,
        clock,
      )
    ).result;
    assert.equal(cancelled.status, "CANCELADA");
    assert.equal(cancelled.rulesAcceptedAt, created.rulesAcceptedAt);
    const after = await physicalState(migration, created.id);
    assert.ok(after.occupancy.every((row) => row.released_at !== null));
    assert.ok(after.consumption.every((row) => row.released));
  });
});

test("the holder must accept current conditions to modify a relocated reservation", {
  timeout: 60000,
}, async () => {
  await withDatabase(async ({ auth, migration, domain }) => {
    const f = await fixture(auth, migration);
    const clock = { now: () => new Date("2030-01-01T00:00:00Z") };
    const created = (
      await createReservation(
        domain,
        f.holder,
        f.tenant,
        "holder-change-create",
        {
          unitId: f.source,
          startsAt: "2030-01-02T10:00:00Z",
          endsAt: "2030-01-02T11:00:00Z",
          acceptance: initialAcceptance,
        },
        randomUUID(),
        3600,
        clock,
      )
    ).result;
    const target = {
      unitId: f.destination,
      startsAt: "2030-01-02T12:00:00Z",
      endsAt: "2030-01-02T13:00:00Z",
    };
    await modifyReservation(
      domain,
      f.admin,
      f.tenant,
      created.id,
      "holder-change-relocation",
      {
        ...target,
        expectedRevision: 1,
        administrative: true,
        reason: "Relocation",
      },
      randomUUID(),
      3600,
      clock,
    );
    await migration.query(
      "INSERT INTO domain.unit_usage_rules(tenant_id,unit_id,version,text_content,actor_id,reason,correlation_id) VALUES($1,$2,2,'Current norms','relocation-admin','Revision',$3)",
      [f.tenant, f.destination, randomUUID()],
    );
    await migration.query(
      "UPDATE domain.reservable_unit SET usage_rules_version=2 WHERE tenant_id=$1 AND id=$2",
      [f.tenant, f.destination],
    );
    const change = {
      ...target,
      startsAt: "2030-01-02T14:00:00Z",
      endsAt: "2030-01-02T15:00:00Z",
      expectedRevision: 2,
    };
    await assert.rejects(
      modifyReservation(
        domain,
        f.holder,
        f.tenant,
        created.id,
        "missing-holder-rules",
        change,
        randomUUID(),
        3600,
        clock,
      ),
      { code: "CONDITIONS_ACCEPTANCE_REQUIRED" },
    );
    await assert.rejects(
      modifyReservation(
        domain,
        f.holder,
        f.tenant,
        created.id,
        "stale-holder-rules",
        {
          ...change,
          acceptance: initialAcceptance,
        },
        randomUUID(),
        3600,
        clock,
      ),
      { code: "CONDITIONS_CHANGED" },
    );
    const modified = (
      await modifyReservation(
        domain,
        f.holder,
        f.tenant,
        created.id,
        "accept-current-and-modify",
        {
          ...change,
          acceptance: { ...initialAcceptance, usageRulesVersion: 2 },
        },
        randomUUID(),
        3600,
        clock,
      )
    ).result;
    assert.equal(modified.revision, 3);
    assert.equal(modified.pendingUsageRulesVersion, null);
    assert.equal(modified.usageRulesUnitId, f.destination);
    assert.equal(modified.usageRulesVersion, 2);
    assert.equal(modified.startsAt, "2030-01-02T14:00:00.000Z");
    const physical = await physicalState(migration, created.id);
    assert.equal(
      physical.occupancy.filter((row) => !row.released_at).length,
      1,
    );
    assert.equal(
      physical.consumption[0].starts_at.toISOString(),
      modified.startsAt,
    );
  });
});

test("concurrent consent and relocation cannot accept norms for a different destination", {
  timeout: 60000,
}, async () => {
  await withDatabase(async ({ auth, migration, domain }) => {
    const f = await fixture(auth, migration);
    const clock = { now: () => new Date("2030-01-01T00:00:00Z") };
    const original = {
      unitId: f.source,
      startsAt: "2030-01-02T10:00:00Z",
      endsAt: "2030-01-02T11:00:00Z",
    };
    const created = (
      await createReservation(
        domain,
        f.holder,
        f.tenant,
        "race-create",
        {
          ...original,
          acceptance: initialAcceptance,
        },
        randomUUID(),
        3600,
        clock,
      )
    ).result;
    await modifyReservation(
      domain,
      f.admin,
      f.tenant,
      created.id,
      "race-first-relocation",
      {
        ...original,
        unitId: f.destination,
        expectedRevision: 1,
        administrative: true,
        reason: "First relocation",
      },
      randomUUID(),
      3600,
      clock,
    );
    const outcomes = await Promise.allSettled([
      acceptReservationUsageRules(
        domain,
        f.holder,
        f.tenant,
        created.id,
        "race-consent",
        {
          expectedRevision: 2,
          unitId: f.destination,
          usageRulesVersion: 1,
        },
        randomUUID(),
        3600,
        clock,
      ),
      modifyReservation(
        domain,
        f.admin,
        f.tenant,
        created.id,
        "race-second-relocation",
        {
          ...original,
          expectedRevision: 2,
          administrative: true,
          reason: "Second relocation",
        },
        randomUUID(),
        3600,
        clock,
      ),
    ]);
    assert.equal(
      outcomes.filter((outcome) => outcome.status === "fulfilled").length,
      1,
    );
    assert.ok(
      outcomes.some(
        (outcome) =>
          outcome.status === "rejected" &&
          outcome.reason.code === "RESERVATION_CHANGED",
      ),
    );
    const current = await readReservation(
      domain,
      f.holder,
      f.tenant,
      created.id,
      clock,
    );
    assert.equal(current.revision, 3);
    assert.equal(current.usageRulesUnitId, current.unitId);
    assert.equal(current.usageRulesVersion, 1);
    assert.equal(current.pendingUsageRulesVersion, null);
    const physical = await physicalState(migration, created.id);
    assert.equal(physical.consumption[0].unit_id, current.unitId);
    assert.equal(
      physical.occupancy.filter((row) => !row.released_at)[0].unit_id,
      current.unitId,
    );
    assert.equal(
      (
        await migration.query(
          "SELECT count(*)::integer AS n FROM domain.reservation_event WHERE reservation_id=$1",
          [created.id],
        )
      ).rows[0].n,
      3,
    );
  });
});

test("pending-rules HTTP acceptance enforces session, origin, idempotency and its response contract", {
  timeout: 60000,
}, async () => {
  await withDatabase(async ({ auth, migration, domain }) => {
    const f = await fixture(auth, migration);
    const config = {
      origin: "https://quenda.test",
      secret: randomBytes(32).toString("hex"),
    };
    const app = await buildApp({
      database: { check: async () => {}, close: async () => {} },
      domain,
      logLevel: "silent",
      idempotencyRetentionSeconds: 3600,
      identity: {
        authentication: createAuthentication(auth, config, {
          send: async () => {},
        }),
        config,
      },
    });
    const contract = verifyProductResponses(app);
    try {
      const client = browser(app, "192.0.2.188");
      const credentials = {
        email: "pending-http@example.test",
        password: "Synthetic-password-1234!",
      };
      const signup = await client.request("/api/auth/sign-up/email", {
        name: "Pending acceptance holder",
        ...credentials,
      });
      assert.equal(signup.statusCode, 200, signup.body);
      const accountId = signup.json().user.id as string;
      await auth.query(
        'UPDATE auth."user" SET "emailVerified"=true WHERE id=$1',
        [accountId],
      );
      const login = await client.request(
        "/api/auth/sign-in/email",
        credentials,
      );
      assert.equal(login.statusCode, 200, login.body);
      const holder = { ...f.holder, accountId, email: credentials.email };
      const start = new Date(
        Math.ceil(Date.now() / 3600000) * 3600000 + 72 * 3600000,
      );
      const input = {
        unitId: f.source,
        startsAt: start.toISOString(),
        endsAt: new Date(start.getTime() + 3600000).toISOString(),
      };
      const created = (
        await createReservation(
          domain,
          holder,
          f.tenant,
          "http-pending-create",
          { ...input, acceptance: initialAcceptance },
          randomUUID(),
          3600,
        )
      ).result;
      await modifyReservation(
        domain,
        f.admin,
        f.tenant,
        created.id,
        "http-pending-relocate",
        {
          ...input,
          unitId: f.destination,
          expectedRevision: 1,
          administrative: true,
          reason: "Relocation",
        },
        randomUUID(),
        3600,
      );
      const physical = await physicalState(migration, created.id);
      const url = `/api/municipalities/${f.tenant}/reservations/${created.id}/accept-usage-rules`;
      const body = {
        expectedRevision: 2,
        unitId: f.destination,
        usageRulesVersion: 1,
      };
      const headers = { "idempotency-key": "http-accept-rules" };
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url,
            payload: body,
            headers: { ...headers, origin: config.origin },
          })
        ).statusCode,
        401,
      );
      assert.equal((await client.request(url, body)).statusCode, 400);
      assert.equal(
        (
          await client.request(url, body, {
            ...headers,
            origin: "https://evil.test",
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await client.request(
            url,
            { ...body, accountId: f.admin.accountId },
            headers,
          )
        ).statusCode,
        400,
      );
      const stale = await client.request(
        url,
        { ...body, usageRulesVersion: 2 },
        headers,
      );
      assert.equal(stale.statusCode, 409, stale.body);
      assert.deepEqual(await physicalState(migration, created.id), physical);
      const accepted = await client.request(url, body, headers);
      assert.equal(accepted.statusCode, 200, accepted.body);
      assert.equal(accepted.json().pendingUsageRulesVersion, null);
      assert.equal(accepted.json().usageRulesUnitId, f.destination);
      assert.equal(accepted.json().usageRulesVersion, 1);
      assert.equal(accepted.json().revision, 3);
      assert.equal(accepted.headers["cache-control"], "no-store");
      const replay = await client.request(url, body, headers);
      assert.equal(replay.statusCode, 200, replay.body);
      assert.equal(replay.headers["idempotency-replayed"], "true");
      assert.deepEqual(replay.json(), accepted.json());
      assert.deepEqual(await physicalState(migration, created.id), physical);
      contract.assertValid();
      assert.ok(
        contract.successes.has(
          "post /api/municipalities/{tenantId}/reservations/{reservationId}/accept-usage-rules",
        ),
      );
    } finally {
      await app.close();
    }
  });
});

test("consent rechecks the start after a lock wait and cannot be forged through runtime SQL", {
  timeout: 60000,
}, async () => {
  await withDatabase(async ({ auth, migration, domain, administration }) => {
    const f = await fixture(auth, migration);
    let now = "2030-01-01T00:00:00Z";
    const clock = { now: () => new Date(now) };
    const input = {
      unitId: f.source,
      startsAt: "2030-01-02T10:00:00Z",
      endsAt: "2030-01-02T11:00:00Z",
    };
    const created = (
      await createReservation(
        domain,
        f.holder,
        f.tenant,
        "wait-create",
        { ...input, acceptance: initialAcceptance },
        randomUUID(),
        3600,
        clock,
      )
    ).result;
    await modifyReservation(
      domain,
      f.admin,
      f.tenant,
      created.id,
      "wait-relocation",
      {
        ...input,
        unitId: f.destination,
        expectedRevision: 1,
        administrative: true,
        reason: "Relocation",
      },
      randomUUID(),
      3600,
      clock,
    );
    const physical = await physicalState(migration, created.id);
    await assert.rejects(
      transaction(
        domain,
        async (client) => {
          await client.query(
            "UPDATE domain.reservation SET usage_rules_unit_id=$3,usage_rules_version=1,rules_accepted_at=clock_timestamp(),pending_usage_rules_version=NULL WHERE tenant_id=$1 AND id=$2",
            [f.tenant, created.id, f.destination],
          );
        },
        { accountId: f.admin.accountId, tenantId: f.tenant },
      ),
      (error: unknown) =>
        ["23514", "42501"].includes((error as { code?: string }).code ?? ""),
    );
    assert.deepEqual(await physicalState(migration, created.id), physical);
    now = "2030-01-02T09:59:59Z";
    const blocker = new Client({
      connectionString: migration.options.connectionString,
    });
    await blocker.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT 1 FROM domain.reservation WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [f.tenant, created.id],
      );
      const rejected = assert.rejects(
        acceptReservationUsageRules(
          domain,
          f.holder,
          f.tenant,
          created.id,
          "wait-consent",
          {
            expectedRevision: 2,
            unitId: f.destination,
            usageRulesVersion: 1,
          },
          randomUUID(),
          3600,
          clock,
        ),
        { code: "RESERVATION_DEADLINE_PASSED" },
      );
      const deadline = Date.now() + 5000;
      let waiting = false;
      while (Date.now() < deadline) {
        const active = await administration.query(
          "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND usename='quenda_domain' AND wait_event_type='Lock' AND query LIKE '%domain.reservation%'",
        );
        if (active.rowCount) {
          waiting = true;
          break;
        }
        await setTimeout(10);
      }
      assert.equal(waiting, true, "Consent must wait for the reservation lock");
      now = "2030-01-02T10:00:00Z";
      await blocker.query("COMMIT");
      await rejected;
      const current = await readReservation(
        domain,
        f.holder,
        f.tenant,
        created.id,
        clock,
      );
      assert.equal(current.revision, 2);
      assert.equal(current.pendingUsageRulesVersion, 1);
      assert.equal(current.usageRulesUnitId, f.source);
      assert.deepEqual(await physicalState(migration, created.id), physical);
    } finally {
      await blocker.query("ROLLBACK");
      await blocker.end();
    }
  });
});

test("subsequent relocation and holder changes preserve the exact accepted timestamps", {
  timeout: 60000,
}, async () => {
  await withDatabase(async ({ auth, migration, domain }) => {
    const f = await fixture(auth, migration);
    const clock = { now: () => new Date("2030-01-01T00:00:00Z") };
    const original = {
      unitId: f.source,
      startsAt: "2030-01-03T10:00:00Z",
      endsAt: "2030-01-03T11:00:00Z",
    };
    const created = (
      await createReservation(
        domain,
        f.holder,
        f.tenant,
        "precision-create",
        { ...original, acceptance: initialAcceptance },
        randomUUID(),
        3600,
        clock,
      )
    ).result;
    const timestamps = async () =>
      (
        await migration.query(
          "SELECT rules_accepted_at::text,conditions_accepted_at::text FROM domain.reservation WHERE tenant_id=$1 AND id=$2",
          [f.tenant, created.id],
        )
      ).rows[0] as {
        rules_accepted_at: string;
        conditions_accepted_at: string;
      };
    const initial = await timestamps();
    await modifyReservation(
      domain,
      f.admin,
      f.tenant,
      created.id,
      "precision-first-relocation",
      {
        ...original,
        unitId: f.destination,
        expectedRevision: 1,
        administrative: true,
        reason: "First relocation",
      },
      randomUUID(),
      3600,
      clock,
    );
    await acceptReservationUsageRules(
      domain,
      f.holder,
      f.tenant,
      created.id,
      "precision-first-acceptance",
      { expectedRevision: 2, unitId: f.destination, usageRulesVersion: 1 },
      randomUUID(),
      3600,
      clock,
    );
    const firstAcceptance = await timestamps();
    assert.equal(
      firstAcceptance.conditions_accepted_at,
      initial.conditions_accepted_at,
    );
    const relocated = (
      await modifyReservation(
        domain,
        f.admin,
        f.tenant,
        created.id,
        "precision-second-relocation",
        {
          ...original,
          startsAt: "2030-01-03T12:00:00Z",
          endsAt: "2030-01-03T13:00:00Z",
          expectedRevision: 3,
          administrative: true,
          reason: "Second relocation after acceptance",
        },
        randomUUID(),
        3600,
        clock,
      )
    ).result;
    assert.equal(relocated.revision, 4);
    assert.equal(relocated.usageRulesUnitId, f.destination);
    assert.equal(relocated.pendingUsageRulesVersion, 1);
    assert.deepEqual(await timestamps(), firstAcceptance);
    await acceptReservationUsageRules(
      domain,
      f.holder,
      f.tenant,
      created.id,
      "precision-second-acceptance",
      { expectedRevision: 4, unitId: f.source, usageRulesVersion: 1 },
      randomUUID(),
      3600,
      clock,
    );
    const secondAcceptance = await timestamps();
    const modified = (
      await modifyReservation(
        domain,
        f.holder,
        f.tenant,
        created.id,
        "precision-holder-reuses-acceptance",
        {
          ...original,
          startsAt: "2030-01-03T14:00:00Z",
          endsAt: "2030-01-03T15:00:00Z",
          expectedRevision: 5,
        },
        randomUUID(),
        3600,
        clock,
      )
    ).result;
    assert.equal(modified.revision, 6);
    assert.equal(modified.usageRulesUnitId, f.source);
    assert.equal(modified.pendingUsageRulesVersion, null);
    assert.deepEqual(await timestamps(), secondAcceptance);
    assert.equal(
      secondAcceptance.conditions_accepted_at,
      initial.conditions_accepted_at,
    );
  });
});
