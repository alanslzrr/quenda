import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { PoolClient } from "pg";
import { idempotentCommand } from "../../src/database/idempotency.ts";
import { transaction } from "../../src/database/transaction.ts";
import { appendReservationEvent } from "../../src/modules/reservations/events.ts";
import { withDatabase } from "../helpers/postgres.ts";

test("database occupancy invariants cover reservations, blocks and concurrent overlap", {
  timeout: 60000,
}, async (t) => {
  await withDatabase(async ({ domain, auth, migration }) => {
    for (const id of ["citizen", "other"])
      await auth.query(
        'INSERT INTO auth."user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())',
        [id, `${id}@example.test`],
      );
    const tenant = randomUUID(),
      foreignTenant = randomUUID(),
      facility = randomUUID(),
      unit = randomUUID(),
      foreignUnit = randomUUID();
    for (const [tenantId, unitId] of [
      [tenant, unit],
      [foreignTenant, foreignUnit],
    ]) {
      await migration.query(
        "INSERT INTO domain.municipality(id,name,timezone) VALUES($1,'Synthetic','Europe/Madrid')",
        [tenantId],
      );
      await migration.query(
        "INSERT INTO domain.municipal_profile(tenant_id,account_id) VALUES($1,'citizen')",
        [tenantId],
      );
      await migration.query(
        "INSERT INTO domain.facility(tenant_id,id,name) VALUES($1,$2,'Facility')",
        [tenantId, facility],
      );
      await migration.query(
        "INSERT INTO domain.reservable_unit(tenant_id,id,facility_id,name) VALUES($1,$2,$3,'Unit')",
        [tenantId, unitId, facility],
      );
      await migration.query(
        "INSERT INTO domain.unit_calendar_version(tenant_id,unit_id,version,minimum_minutes,maximum_minutes,step_minutes,weekly,exceptions,actor_id,reason) VALUES($1,$2,1,30,120,30,'[]','[]','citizen','Fixture')",
        [tenantId, unitId],
      );
    }
    const context = { accountId: "citizen", tenantId: tenant };
    const reservation = async (
      c: PoolClient,
      start: string,
      end: string,
      id = randomUUID(),
      unitId = unit,
    ) => {
      await c.query(
        "INSERT INTO domain.reservation(tenant_id,id,account_id,unit_id,calendar_version,starts_at,ends_at,cancellation_minutes,timezone) VALUES($1,$2,'citizen',$3,1,$4,$5,0,'Europe/Madrid')",
        [tenant, id, unitId, start, end],
      );
      return id;
    };
    const occupy = async (
      c: PoolClient,
      id: string,
      start: string,
      end: string,
      unitId = unit,
    ) =>
      c.query(
        "INSERT INTO domain.occupancy(tenant_id,id,unit_id,reservation_id,period) VALUES($1,$2,$3,$4,tstzrange($5,$6,'[)'))",
        [tenant, randomUUID(), unitId, id, start, end],
      );
    const book = (start: string, end: string) =>
      transaction(
        domain,
        async (c) => {
          const id = await reservation(c, start, end);
          await occupy(c, id, start, end);
          return id;
        },
        context,
      );
    const start = "2030-01-01T10:00:00Z",
      end = "2030-01-01T11:00:00Z";
    let winner = "";
    await t.test(
      "100 overlapping transactions leave exactly one reservation and one active occupancy",
      async () => {
        const outcomes = await Promise.allSettled(
          Array.from({ length: 100 }, () => book(start, end)),
        );
        const successes = outcomes.filter(
          (outcome) => outcome.status === "fulfilled",
        );
        assert.equal(successes.length, 1);
        winner = successes[0]?.value ?? "";
        assert.ok(
          outcomes
            .filter((o) => o.status === "rejected")
            .every(
              (o) =>
                o.status === "rejected" &&
                ["23P01", "40001"].includes(o.reason.code),
            ),
        );
        assert.equal(
          (
            await migration.query(
              "SELECT count(*)::int AS n FROM domain.reservation",
            )
          ).rows[0].n,
          1,
        );
        assert.equal(
          (
            await migration.query(
              "SELECT count(*)::int AS n FROM domain.occupancy WHERE released_at IS NULL",
            )
          ).rows[0].n,
          1,
        );
      },
    );
    await t.test(
      "confirmed reservations require exactly one matching active occupancy at commit",
      async () => {
        await assert.rejects(
          transaction(
            domain,
            (c) => reservation(c, "2030-01-02T10:00Z", "2030-01-02T11:00Z"),
            context,
          ),
          { code: "23514" },
        );
        await assert.rejects(
          transaction(
            domain,
            async (c) => {
              const id = await reservation(
                c,
                "2030-01-02T10:00Z",
                "2030-01-02T11:00Z",
              );
              await occupy(c, id, "2030-01-02T10:00Z", "2030-01-02T12:00Z");
            },
            context,
          ),
          { code: "23514" },
        );
        await assert.rejects(
          transaction(
            domain,
            (c) =>
              c.query(
                "UPDATE domain.reservation SET status='CANCELADA' WHERE tenant_id=$1 AND id=$2",
                [tenant, winner],
              ),
            context,
          ),
          { code: "23514" },
        );
        await assert.rejects(
          transaction(
            domain,
            (c) =>
              c.query(
                "UPDATE domain.occupancy SET released_at=now() WHERE tenant_id=$1 AND reservation_id=$2",
                [tenant, winner],
              ),
            context,
          ),
          { code: "23514" },
        );
      },
    );
    await t.test(
      "adjacent bookings are compatible; atomic cancellation releases the original interval",
      async () => {
        await book(end, "2030-01-01T12:00:00Z");
        await transaction(
          domain,
          async (c) => {
            await c.query(
              "UPDATE domain.reservation SET status='CANCELADA',revision=revision+1 WHERE tenant_id=$1 AND id=$2",
              [tenant, winner],
            );
            await c.query(
              "UPDATE domain.occupancy SET released_at=now() WHERE tenant_id=$1 AND reservation_id=$2",
              [tenant, winner],
            );
          },
          context,
        );
        await book(start, end);
        assert.equal(
          (
            await migration.query(
              "SELECT count(*)::int AS n FROM domain.occupancy WHERE reservation_id=$1 AND released_at IS NOT NULL",
              [winner],
            )
          ).rows[0].n,
          1,
        );
      },
    );
    await t.test(
      "moving a booking replaces occupancy atomically and restores it on conflict",
      async () => {
        const id = await book("2030-01-06T10:00Z", "2030-01-06T11:00Z");
        await book("2030-01-06T12:00Z", "2030-01-06T13:00Z");
        const move = (start: string, end: string) =>
          transaction(
            domain,
            async (c) => {
              await c.query(
                "UPDATE domain.occupancy SET released_at=now() WHERE tenant_id=$1 AND reservation_id=$2 AND released_at IS NULL",
                [tenant, id],
              );
              await c.query(
                "UPDATE domain.reservation SET starts_at=$3,ends_at=$4,revision=revision+1 WHERE tenant_id=$1 AND id=$2",
                [tenant, id, start, end],
              );
              await occupy(c, id, start, end);
            },
            context,
          );
        await assert.rejects(move("2030-01-06T12:00Z", "2030-01-06T13:00Z"), {
          code: "23P01",
        });
        const original = await migration.query(
          "SELECT revision,starts_at FROM domain.reservation WHERE tenant_id=$1 AND id=$2",
          [tenant, id],
        );
        assert.equal(original.rows[0].revision, 1);
        assert.equal(
          original.rows[0].starts_at.toISOString(),
          "2030-01-06T10:00:00.000Z",
        );
        await assert.rejects(book("2030-01-06T10:00Z", "2030-01-06T11:00Z"), {
          code: "23P01",
        });
        await move("2030-01-06T14:00Z", "2030-01-06T15:00Z");
        await book("2030-01-06T10:00Z", "2030-01-06T11:00Z");
        const history = await migration.query(
          "SELECT count(*)::int AS total,count(*) FILTER(WHERE released_at IS NULL)::int AS active FROM domain.occupancy WHERE tenant_id=$1 AND reservation_id=$2",
          [tenant, id],
        );
        assert.deepEqual(history.rows[0], { total: 2, active: 1 });
      },
    );
    await t.test(
      "blocks and bookings share the same exclusion and coherence requirements",
      async () => {
        const block = randomUUID();
        await assert.rejects(
          transaction(migration, async (c) => {
            await c.query(
              "INSERT INTO domain.schedule_block(tenant_id,id,unit_id,starts_at,ends_at,actor_id,reason) VALUES($1,$2,$3,$4,$5,'citizen','Block')",
              [tenant, block, unit, start, end],
            );
            await c.query(
              "INSERT INTO domain.occupancy(tenant_id,id,unit_id,block_id,period) VALUES($1,$2,$3,$4,tstzrange($5,$6,'[)'))",
              [tenant, randomUUID(), unit, block, start, end],
            );
          }),
          { code: "23P01" },
        );
        await assert.rejects(
          transaction(migration, (c) =>
            c.query(
              "INSERT INTO domain.schedule_block(tenant_id,id,unit_id,starts_at,ends_at,actor_id,reason) VALUES($1,$2,$3,'2030-01-03T10:00Z','2030-01-03T11:00Z','citizen','Missing occupancy')",
              [tenant, randomUUID(), unit],
            ),
          ),
          { code: "23514" },
        );
        await transaction(migration, async (c) => {
          await c.query(
            "INSERT INTO domain.schedule_block(tenant_id,id,unit_id,starts_at,ends_at,actor_id,reason) VALUES($1,$2,$3,'2030-01-03T10:00Z','2030-01-03T11:00Z','citizen','Block')",
            [tenant, block, unit],
          );
          await c.query(
            "INSERT INTO domain.occupancy(tenant_id,id,unit_id,block_id,period) VALUES($1,$2,$3,$4,'[2030-01-03T10:00Z,2030-01-03T11:00Z)'::tstzrange)",
            [tenant, randomUUID(), unit, block],
          );
        });
        await assert.rejects(book("2030-01-03T10:00Z", "2030-01-03T11:00Z"), {
          code: "23P01",
        });
      },
    );
    await t.test(
      "events and both notices commit with idempotent reservation changes",
      async () => {
        const correlation = randomUUID();
        const options = {
          operation: "reservation.create",
          key: "event-create",
          input: { start: "2030-02-01T10:00Z", end: "2030-02-01T11:00Z" },
          retentionSeconds: 3600,
          authorize: async () => {},
          execute: async (c: PoolClient) => {
            const id = await reservation(
              c,
              "2030-02-01T10:00Z",
              "2030-02-01T11:00Z",
            );
            await occupy(c, id, "2030-02-01T10:00Z", "2030-02-01T11:00Z");
            const eventId = await appendReservationEvent(c, id, correlation);
            return { id, eventId };
          },
        };
        const initial = await idempotentCommand(domain, context, options);
        const replay = await idempotentCommand(domain, context, options);
        assert.equal(replay.replayed, true);
        assert.deepEqual(replay.result, initial.result);
        const id = initial.result.id;
        const counts = async () =>
          (
            await migration.query(`SELECT
        (SELECT count(*)::int FROM domain.reservation_event) AS events,
        (SELECT count(*)::int FROM domain.reservation_notice) AS notices,
        (SELECT count(*)::int FROM domain.reservation_email) AS emails`)
          ).rows[0];
        assert.deepEqual(await counts(), { events: 1, notices: 1, emails: 1 });
        await assert.rejects(
          transaction(
            domain,
            (c) => appendReservationEvent(c, id, correlation),
            context,
          ),
          { code: "23514" },
        );
        await assert.rejects(
          transaction(
            domain,
            (c) =>
              c.query(
                "UPDATE domain.reservation SET cancellation_minutes=5 WHERE tenant_id=$1 AND id=$2",
                [tenant, id],
              ),
            context,
          ),
          { code: "23514" },
        );
        const change = async (c: PoolClient) => {
          await c.query(
            "UPDATE domain.occupancy SET released_at=now() WHERE tenant_id=$1 AND reservation_id=$2 AND released_at IS NULL",
            [tenant, id],
          );
          await c.query(
            "UPDATE domain.reservation SET starts_at='2030-02-01T12:00Z',ends_at='2030-02-01T13:00Z',revision=revision+1 WHERE tenant_id=$1 AND id=$2",
            [tenant, id],
          );
          await occupy(c, id, "2030-02-01T12:00Z", "2030-02-01T13:00Z");
          await appendReservationEvent(c, id, correlation);
        };
        await assert.rejects(
          transaction(
            domain,
            async (c) => {
              await change(c);
              throw new Error("Abort after outbox");
            },
            context,
          ),
          /Abort after outbox/,
        );
        assert.deepEqual(await counts(), { events: 1, notices: 1, emails: 1 });
        await transaction(domain, change, context);
        await transaction(
          domain,
          async (c) => {
            await c.query(
              "UPDATE domain.reservation SET status='CANCELADA',revision=revision+1 WHERE tenant_id=$1 AND id=$2",
              [tenant, id],
            );
            await c.query(
              "UPDATE domain.occupancy SET released_at=now() WHERE tenant_id=$1 AND reservation_id=$2 AND released_at IS NULL",
              [tenant, id],
            );
            await appendReservationEvent(c, id, correlation);
          },
          context,
        );
        const events = (
          await migration.query(
            "SELECT * FROM domain.reservation_event WHERE reservation_id=$1 ORDER BY revision",
            [id],
          )
        ).rows;
        assert.deepEqual(
          events.map((e) => e.kind),
          ["CONFIRMADA", "MODIFICADA", "CANCELADA"],
        );
        assert.equal(events[0].before_state, null);
        assert.deepEqual(events[1].before_state, events[0].after_state);
        assert.deepEqual(events[2].before_state, events[1].after_state);
        assert.ok(
          events.every(
            (e) => e.actor_id === "citizen" && e.correlation_id === correlation,
          ),
        );
        assert.deepEqual(await counts(), { events: 3, notices: 3, emails: 3 });
        await transaction(
          domain,
          async (c) => {
            assert.equal(
              (await c.query("SELECT * FROM domain.reservation_event"))
                .rowCount,
              0,
            );
            assert.equal(
              (await c.query("SELECT * FROM domain.reservation_notice"))
                .rowCount,
              0,
            );
          },
          { accountId: "other", tenantId: tenant },
        );
        await assert.rejects(
          transaction(
            domain,
            (c) => appendReservationEvent(c, id, correlation),
            { accountId: "other", tenantId: tenant },
          ),
          { code: "42501" },
        );
        await assert.rejects(
          transaction(
            domain,
            (c) => appendReservationEvent(c, id, correlation),
            { accountId: "citizen", tenantId: foreignTenant },
          ),
          { code: "42501" },
        );
        for (const table of [
          "reservation_event",
          "reservation_notice",
          "reservation_email",
        ]) {
          await assert.rejects(
            transaction(
              domain,
              (c) => c.query(`DELETE FROM domain.${table}`),
              context,
            ),
            { code: "42501" },
          );
        }
        await assert.rejects(
          transaction(
            domain,
            (c) =>
              c.query("UPDATE domain.reservation_event SET reason='tampered'"),
            context,
          ),
          { code: "42501" },
        );
        await assert.rejects(
          transaction(
            domain,
            (c) => c.query("SELECT * FROM domain.reservation_email"),
            context,
          ),
          { code: "42501" },
        );
      },
    );
    await t.test(
      "ranges, exclusive origin, tenant references and RLS fail closed",
      async () => {
        for (const period of [
          "empty",
          "(2030-01-04T10:00Z,2030-01-04T11:00Z)",
          "[2030-01-04T10:00Z,2030-01-04T11:00Z]",
          "[2030-01-04T10:00Z,)",
          "[-infinity,2030-01-04T11:00Z)",
        ])
          await assert.rejects(
            transaction(migration, (c) =>
              c.query(
                "INSERT INTO domain.occupancy(tenant_id,id,unit_id,reservation_id,period) VALUES($1,$2,$3,$4,$5::tstzrange)",
                [tenant, randomUUID(), unit, winner, period],
              ),
            ),
            { code: "23514" },
          );
        await assert.rejects(
          transaction(migration, (c) =>
            c.query(
              "INSERT INTO domain.occupancy(tenant_id,id,unit_id,period) VALUES($1,$2,$3,'[2030-01-05T10:00Z,2030-01-05T11:00Z)')",
              [tenant, randomUUID(), unit],
            ),
          ),
          { code: "23514" },
        );
        await assert.rejects(
          transaction(
            domain,
            (c) =>
              reservation(
                c,
                "2030-01-05T10:00Z",
                "2030-01-05T11:00Z",
                randomUUID(),
                foreignUnit,
              ),
            context,
          ),
          { code: "23503" },
        );
        assert.equal(
          (await domain.query("SELECT * FROM domain.reservation")).rowCount,
          0,
        );
        await transaction(
          domain,
          async (c) =>
            assert.equal(
              (await c.query("SELECT * FROM domain.reservation")).rowCount,
              0,
            ),
          { accountId: "other", tenantId: tenant },
        );
        await assert.rejects(domain.query("DELETE FROM domain.occupancy"), {
          code: "42501",
        });
      },
    );
  });
});
