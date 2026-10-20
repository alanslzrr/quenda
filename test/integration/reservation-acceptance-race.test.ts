import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { Client, type Pool } from "pg";
import {
  cancelReservation,
  createReservation,
} from "../../src/modules/reservations/index.ts";
import { withDatabase } from "../helpers/postgres.ts";
import { seedUsageRules } from "../helpers/usage-rules-fixture.ts";

async function waitForLock(administration: Pool, query: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await administration.query(
      `SELECT 1 FROM pg_stat_activity
       WHERE datname=current_database() AND usename='quenda_domain'
       AND wait_event_type='Lock' AND query LIKE $1`,
      [`%${query}%`],
    );
    if (result.rowCount) return;
    await setTimeout(10);
  }
  assert.fail(`Command did not wait on ${query}`);
}

test("acceptance uses conditions and deadline after lock waits, without partial effects", {
  timeout: 60000,
}, async (t) => {
  await withDatabase(async ({ auth, domain, migration, administration }) => {
    const tenantId = randomUUID(),
      facilityId = randomUUID(),
      unitId = randomUUID();
    const actor = {
      accountId: "acceptance-race-citizen",
      email: "acceptance-race-citizen@example.test",
      sessionId: "verified-race-session",
      mfaVerifiedAt: null,
    };
    await auth.query(
      'INSERT INTO auth."user"(id,name,email,"emailVerified") VALUES($1,$1,$2,true)',
      [actor.accountId, actor.email],
    );
    await migration.query(
      "INSERT INTO domain.municipality(id,name,timezone) VALUES($1,'Race','Europe/Madrid')",
      [tenantId],
    );
    await migration.query(
      "INSERT INTO domain.facility(tenant_id,id,name,published_at) VALUES($1,$2,'Facility',now())",
      [tenantId, facilityId],
    );
    await migration.query(
      "INSERT INTO domain.reservable_unit(tenant_id,id,facility_id,name) VALUES($1,$2,$3,'Unit')",
      [tenantId, unitId, facilityId],
    );
    await migration.query(
      `INSERT INTO domain.unit_calendar_version(tenant_id,unit_id,version,minimum_minutes,maximum_minutes,step_minutes,weekly,exceptions,actor_id,reason)
       VALUES($1,$2,1,60,60,60,$3,'[]',$4,'Synthetic fixture')`,
      [
        tenantId,
        unitId,
        JSON.stringify(
          Array.from({ length: 7 }, (_, day) => ({
            day: day + 1,
            startMinute: 0,
            endMinute: 1440,
          })),
        ),
        actor.accountId,
      ],
    );
    await seedUsageRules(migration, tenantId, unitId, actor.accountId);
    await migration.query(
      "UPDATE domain.reservable_unit SET calendar_version=1,published_at=now() WHERE tenant_id=$1 AND id=$2",
      [tenantId, unitId],
    );
    let now = new Date("2030-01-01T09:59:59Z");
    const clock = { now: () => new Date(now) };
    const input = {
      unitId,
      startsAt: "2030-01-02T10:00:00Z",
      endsAt: "2030-01-02T11:00:00Z",
      acceptance: {
        usageRulesVersion: 1,
        bookingPolicyVersion: 1,
        nonCancellable: false,
      },
    };
    const create = (key: string, body = input) =>
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
    const assertNoEffects = async () => {
      for (const table of [
        "reservation",
        "occupancy",
        "reservation_event",
        "reservation_notice",
        "reservation_email",
        "idempotent_command",
        "municipal_profile",
      ])
        assert.equal(
          (
            await migration.query(
              `SELECT count(*)::integer AS n FROM domain.${table}`,
            )
          ).rows[0].n,
          0,
          table,
        );
    };
    const blocker = new Client({
      connectionString: migration.options.connectionString,
    });
    await blocker.connect();
    try {
      await t.test(
        "a version replaced while the command waits is not silently accepted",
        async () => {
          await blocker.query("BEGIN");
          try {
            await blocker.query(
              "SELECT 1 FROM domain.reservable_unit WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
              [tenantId, unitId],
            );
            const rejected = assert.rejects(create("rules-race"), {
              code: "CONDITIONS_CHANGED",
            });
            await waitForLock(administration, "reservation_conditions");
            await blocker.query(
              `INSERT INTO domain.unit_usage_rules(tenant_id,unit_id,version,text_content,actor_id,reason,correlation_id)
             VALUES($1,$2,2,'New synthetic rules',$3,'Synthetic revision',$4)`,
              [tenantId, unitId, actor.accountId, randomUUID()],
            );
            await blocker.query(
              "UPDATE domain.reservable_unit SET usage_rules_version=2 WHERE tenant_id=$1 AND id=$2",
              [tenantId, unitId],
            );
            await blocker.query("COMMIT");
            await rejected;
            await assertNoEffects();
          } finally {
            await blocker.query("ROLLBACK");
          }
        },
      );
      await t.test(
        "crossing the cancellation cutoff while waiting requires express non-cancellable acceptance",
        async () => {
          await blocker.query("BEGIN");
          try {
            await blocker.query(
              "SELECT 1 FROM domain.reservable_unit WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
              [tenantId, unitId],
            );
            const rejected = assert.rejects(
              create("cutoff-race", {
                ...input,
                acceptance: { ...input.acceptance, usageRulesVersion: 2 },
              }),
              { code: "CONDITIONS_CHANGED" },
            );
            await waitForLock(administration, "reservation_conditions");
            now = new Date("2030-01-01T10:00:00.001Z");
            await blocker.query("COMMIT");
            await rejected;
            await assertNoEffects();
          } finally {
            await blocker.query("ROLLBACK");
          }
        },
      );
      await t.test(
        "a denied late cancellation preserves reservation, occupation and all event evidence",
        async () => {
          const booking = (
            await create("explicit-non-cancellable", {
              ...input,
              acceptance: {
                ...input.acceptance,
                usageRulesVersion: 2,
                nonCancellable: true,
              },
            })
          ).result;
          const state = async () => ({
            reservation: (
              await migration.query("SELECT * FROM domain.reservation")
            ).rows,
            occupancy: (await migration.query("SELECT * FROM domain.occupancy"))
              .rows,
            events: (
              await migration.query("SELECT * FROM domain.reservation_event")
            ).rows,
            notices: (
              await migration.query("SELECT * FROM domain.reservation_notice")
            ).rows,
            email: (
              await migration.query("SELECT * FROM domain.reservation_email")
            ).rows,
          });
          const before = await state();
          await assert.rejects(
            cancelReservation(
              domain,
              actor,
              tenantId,
              booking.id,
              "denied-late",
              { expectedRevision: 1 },
              randomUUID(),
              3600,
              clock,
            ),
            { code: "RESERVATION_DEADLINE_PASSED" },
          );
          assert.deepEqual(await state(), before);
          assert.equal(booking.nonCancellableAccepted, true);
          assert.equal(before.reservation[0].status, "CONFIRMADA");
          assert.equal(before.occupancy[0].released_at, null);
        },
      );
    } finally {
      await blocker.end();
    }
  });
});
