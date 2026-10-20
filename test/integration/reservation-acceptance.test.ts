import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  cancelReservation,
  createReservation,
  modifyReservation,
} from "../../src/modules/reservations/index.ts";
import { readReservation } from "../../src/modules/reservations/queries.ts";
import { withDatabase } from "../helpers/postgres.ts";

test("explicit acceptance preserves legacy evidence and accepted cancellation conditions", {
  timeout: 60000,
}, async () => {
  await withDatabase(async ({ migration, auth, domain }) => {
    const tenantId = randomUUID(),
      facilityId = randomUUID(),
      unitId = randomUUID(),
      secondUnit = randomUUID();
    const actor = {
      accountId: "acceptor",
      email: "acceptor@example.test",
      sessionId: "test",
      mfaVerifiedAt: new Date(),
    };
    await auth.query(
      'INSERT INTO auth."user"(id,name,email,"emailVerified") VALUES($1,$1,$2,true)',
      [actor.accountId, actor.email],
    );
    await migration.query(
      "INSERT INTO domain.municipality(id,name,timezone) VALUES($1,'Acceptance','Europe/Madrid')",
      [tenantId],
    );
    assert.equal(
      (
        await migration.query(
          "SELECT cancellation_minutes FROM domain.municipality WHERE id=$1",
          [tenantId],
        )
      ).rows[0].cancellation_minutes,
      1440,
    );
    await migration.query(
      "INSERT INTO domain.facility(tenant_id,id,name,published_at) VALUES($1,$2,'Sports',now())",
      [tenantId, facilityId],
    );
    for (const id of [unitId, secondUnit]) {
      await migration.query(
        "INSERT INTO domain.reservable_unit(tenant_id,id,facility_id,name) VALUES($1,$2,$3,'Court')",
        [tenantId, id, facilityId],
      );
      await migration.query(
        "INSERT INTO domain.unit_calendar_version(tenant_id,unit_id,version,minimum_minutes,maximum_minutes,step_minutes,weekly,exceptions,actor_id,reason) VALUES($1,$2,1,60,60,60,$3,'[]',$4,'Test')",
        [
          tenantId,
          id,
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
      await migration.query(
        "INSERT INTO domain.unit_usage_rules(tenant_id,unit_id,version,text_content,actor_id,reason,correlation_id) VALUES($1,$2,1,'Use sports shoes',$3,'Initial',$4)",
        [tenantId, id, actor.accountId, randomUUID()],
      );
      await migration.query(
        "UPDATE domain.reservable_unit SET calendar_version=1,usage_rules_version=1,published_at=now() WHERE tenant_id=$1 AND id=$2",
        [tenantId, id],
      );
    }
    const start = new Date(
      Math.ceil(Date.now() / 3600000) * 3600000 + 48 * 3600000,
    );
    let now = new Date(start.getTime() - 48 * 3600000);
    const clock = { now: () => now };
    const input = {
      unitId,
      startsAt: start.toISOString(),
      endsAt: new Date(start.getTime() + 3600000).toISOString(),
    };
    const acceptance = {
      usageRulesVersion: 1,
      bookingPolicyVersion: 1,
      nonCancellable: false,
    };
    const create = (
      body: Parameters<typeof createReservation>[4],
      key = randomUUID(),
    ) =>
      createReservation(
        domain,
        actor,
        tenantId,
        key,
        body,
        randomUUID(),
        3600,
        clock,
      );
    await assert.rejects(create(input), {
      code: "CONDITIONS_ACCEPTANCE_REQUIRED",
    });
    await assert.rejects(
      create({ ...input, acceptance: { ...acceptance, usageRulesVersion: 2 } }),
      { code: "CONDITIONS_CHANGED" },
    );
    const original = (await create({ ...input, acceptance })).result;
    assert.equal(original.cancellationMinutes, 1440);
    assert.equal(original.usageRulesVersion, 1);
    assert.ok(original.rulesAcceptedAt);
    const reservationId = original.id;
    const modify = (body: Parameters<typeof modifyReservation>[5]) =>
      modifyReservation(
        domain,
        actor,
        tenantId,
        reservationId,
        randomUUID(),
        body,
        randomUUID(),
        3600,
        clock,
      );
    const moved = {
      ...input,
      startsAt: new Date(start.getTime() + 2 * 3600000).toISOString(),
      endsAt: new Date(start.getTime() + 3 * 3600000).toISOString(),
    };
    // A changed rules version must never replace accepted version 1 silently.
    await migration.query(
      "INSERT INTO domain.unit_usage_rules SELECT tenant_id,unit_id,2,'New rules',actor_id,'Revision',$3,clock_timestamp() FROM domain.unit_usage_rules WHERE tenant_id=$1 AND unit_id=$2 AND version=1",
      [tenantId, unitId, randomUUID()],
    );
    await migration.query(
      "UPDATE domain.reservable_unit SET usage_rules_version=2 WHERE tenant_id=$1 AND id=$2",
      [tenantId, unitId],
    );
    await assert.rejects(modify({ ...moved, expectedRevision: 1 }), {
      code: "CONDITIONS_ACCEPTANCE_REQUIRED",
    });
    await assert.rejects(
      modify({ ...moved, expectedRevision: 1, acceptance }),
      { code: "CONDITIONS_CHANGED" },
    );
    assert.equal(
      (await readReservation(domain, actor, tenantId, reservationId, clock))
        .startsAt,
      input.startsAt,
    );
    assert.equal(
      (await readReservation(domain, actor, tenantId, reservationId, clock))
        .usageRulesText,
      "Use sports shoes",
    );
    const changed = (
      await modify({
        ...moved,
        expectedRevision: 1,
        acceptance: { ...acceptance, usageRulesVersion: 2 },
      })
    ).result;
    assert.equal(changed.revision, 2);
    assert.equal(changed.usageRulesVersion, 2);
    const events = (
      await migration.query(
        "SELECT before_state,after_state FROM domain.reservation_event WHERE tenant_id=$1 AND reservation_id=$2 ORDER BY revision",
        [tenantId, reservationId],
      )
    ).rows;
    assert.equal(events[0].after_state.usageRulesVersion, 1);
    assert.equal(events[1].before_state.usageRulesVersion, 1);
    assert.equal(events[1].after_state.usageRulesVersion, 2);
    // Legacy acceptance is missing evidence, not a reservation status.
    const legacy = randomUUID();
    await migration.query(
      "INSERT INTO domain.municipal_profile(tenant_id,account_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
      [tenantId, actor.accountId],
    );
    const client = await migration.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO domain.reservation(tenant_id,id,account_id,unit_id,calendar_version,starts_at,ends_at,cancellation_minutes,timezone) VALUES($1,$2,$3,$4,1,$5,$6,0,'Europe/Madrid')",
        [
          tenantId,
          legacy,
          actor.accountId,
          secondUnit,
          input.startsAt,
          input.endsAt,
        ],
      );
      await client.query(
        "INSERT INTO domain.occupancy(tenant_id,id,unit_id,reservation_id,period) VALUES($1,$2,$3,$4,tstzrange($5,$6,'[)'))",
        [
          tenantId,
          randomUUID(),
          secondUnit,
          legacy,
          input.startsAt,
          input.endsAt,
        ],
      );
      await client.query(
        "SELECT set_config('quenda.account_id',$1,true),set_config('quenda.tenant_id',$2,true)",
        [actor.accountId, tenantId],
      );
      await client.query(
        "SELECT domain.append_reservation_event($1,$2,$3,NULL)",
        [legacy, randomUUID(), randomUUID()],
      );
      await client.query(
        "UPDATE domain.reservation_event SET after_state=after_state-ARRAY['usageRulesVersion','rulesAcceptedAt','bookingPolicyVersion','conditionsAcceptedAt','nonCancellableAccepted'],administrative=NULL WHERE tenant_id=$1 AND reservation_id=$2",
        [tenantId, legacy],
      );
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const legacyRead = await readReservation(
      domain,
      actor,
      tenantId,
      legacy,
      clock,
    );
    assert.equal(legacyRead.status, "CONFIRMADA");
    assert.equal(legacyRead.usageRulesVersion, null);
    assert.equal(legacyRead.cancellationMinutes, 0);
    const legacyNoop = await modifyReservation(
      domain,
      actor,
      tenantId,
      legacy,
      randomUUID(),
      { ...input, unitId: secondUnit, expectedRevision: 1 },
      randomUUID(),
      3600,
      clock,
    );
    assert.equal(legacyNoop.result.usageRulesVersion, null);
    assert.equal(legacyNoop.result.revision, 1);
    await assert.rejects(
      modifyReservation(
        domain,
        actor,
        tenantId,
        legacy,
        randomUUID(),
        { ...moved, unitId: secondUnit, expectedRevision: 1 },
        randomUUID(),
        3600,
        clock,
      ),
      { code: "CONDITIONS_ACCEPTANCE_REQUIRED" },
    );
    await cancelReservation(
      domain,
      actor,
      tenantId,
      legacy,
      randomUUID(),
      { expectedRevision: 1 },
      randomUUID(),
      3600,
      clock,
    );
    assert.equal(
      (await readReservation(domain, actor, tenantId, legacy, clock))
        .usageRulesVersion,
      null,
    );
    // Short-notice bookings are allowed only with explicit acknowledgement.
    now = new Date(start.getTime() - 3600000);
    await assert.rejects(create({ ...input, unitId: secondUnit, acceptance }), {
      code: "CONDITIONS_CHANGED",
    });
    const short = (
      await create({
        ...input,
        unitId: secondUnit,
        acceptance: { ...acceptance, nonCancellable: true },
      })
    ).result;
    await assert.rejects(
      cancelReservation(
        domain,
        actor,
        tenantId,
        short.id,
        randomUUID(),
        { expectedRevision: 1 },
        randomUUID(),
        3600,
        clock,
      ),
      { code: "RESERVATION_DEADLINE_PASSED" },
    );
    await assert.rejects(
      modifyReservation(
        domain,
        actor,
        tenantId,
        short.id,
        randomUUID(),
        { ...moved, unitId: secondUnit, expectedRevision: 1 },
        randomUUID(),
        3600,
        clock,
      ),
      { code: "RESERVATION_DEADLINE_PASSED" },
    );
    assert.equal(
      (
        await migration.query(
          "SELECT count(*)::integer AS n FROM domain.occupancy WHERE reservation_id=$1 AND released_at IS NULL",
          [short.id],
        )
      ).rows[0].n,
      1,
    );
    // Municipal policy changes do not retroactively relax/replace accepted deadlines.
    await migration.query(
      "UPDATE domain.municipality SET cancellation_minutes=0,booking_policy_version=2 WHERE id=$1",
      [tenantId],
    );
    await assert.rejects(
      cancelReservation(
        domain,
        actor,
        tenantId,
        short.id,
        randomUUID(),
        { expectedRevision: 1 },
        randomUUID(),
        3600,
        clock,
      ),
      { code: "RESERVATION_DEADLINE_PASSED" },
    );
    now = new Date(Date.parse(changed.startsAt) - 1440 * 60000);
    await cancelReservation(
      domain,
      actor,
      tenantId,
      reservationId,
      randomUUID(),
      { expectedRevision: 2 },
      randomUUID(),
      3600,
      clock,
    );
    assert.equal(
      (await readReservation(domain, actor, tenantId, reservationId, clock))
        .status,
      "CANCELADA",
    );
  });
});
