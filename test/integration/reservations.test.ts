import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  cancelReservation,
  createReservation,
  modifyReservation,
} from "../../src/modules/reservations/index.ts";
import { withDatabase } from "../helpers/postgres.ts";

test("reservation confirmation validates real calendars and commits every effect once", {
  timeout: 60000,
}, async (t) => {
  await withDatabase(async ({ domain, auth, migration }) => {
    for (const id of ["citizen", "newcomer"])
      await auth.query(
        `INSERT INTO auth."user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())`,
        [id, `${id}@example.test`],
      );
    const tenant = randomUUID(),
      facility = randomUUID(),
      unit = randomUUID(),
      draft = randomUUID();
    await migration.query(
      "INSERT INTO domain.municipality(id,name,timezone) VALUES($1,'Synthetic','Europe/Madrid')",
      [tenant],
    );
    await migration.query(
      "INSERT INTO domain.facility(tenant_id,id,name,published_at) VALUES($1,$2,'Facility',now())",
      [tenant, facility],
    );
    const weekly = Array.from({ length: 7 }, (_, i) => ({
      day: i + 1,
      startMinute: 480,
      endMinute: 1080,
    }));
    for (const id of [unit, draft]) {
      await migration.query(
        "INSERT INTO domain.reservable_unit(tenant_id,id,facility_id,name) VALUES($1,$2,$3,'Unit')",
        [tenant, id, facility],
      );
      await migration.query(
        `INSERT INTO domain.unit_calendar_version(tenant_id,unit_id,version,minimum_minutes,maximum_minutes,step_minutes,weekly,exceptions,actor_id,reason)
    VALUES($1,$2,1,30,120,30,$3,'[{"date":"2030-01-03","intervals":[]}]','citizen','Fixture')`,
        [tenant, id, JSON.stringify(weekly)],
      );
      await migration.query(
        "UPDATE domain.reservable_unit SET calendar_version=1 WHERE tenant_id=$1 AND id=$2",
        [tenant, id],
      );
    }
    await migration.query(
      "UPDATE domain.reservable_unit SET published_at=now() WHERE tenant_id=$1 AND id=$2",
      [tenant, unit],
    );
    const actor = {
      accountId: "citizen",
      email: "citizen@example.test",
      sessionId: "verified-session",
      mfaVerifiedAt: null,
    };
    const clock = { now: () => new Date("2030-01-01T00:00:00Z") };
    const input = {
      unitId: unit,
      startsAt: "2030-01-02T10:00:00Z",
      endsAt: "2030-01-02T11:00:00Z",
    };
    const create = (key: string, data = input, who = actor) =>
      createReservation(
        domain,
        who,
        tenant,
        key,
        data,
        randomUUID(),
        3600,
        clock,
      );
    await t.test(
      "100 competing commands confirm only one complete reservation",
      async () => {
        const attempts = await Promise.allSettled(
          Array.from({ length: 100 }, (_, i) => create(`race-${i}`)),
        );
        const successes = attempts.filter((r) => r.status === "fulfilled");
        assert.equal(successes.length, 1);
        assert.ok(
          attempts
            .filter((r) => r.status === "rejected")
            .every((r) => r.reason.code === "CONFLICT"),
        );
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
                `SELECT count(*)::int AS n FROM domain.${table}`,
              )
            ).rows[0].n,
            1,
            table,
          );
      },
    );
    await t.test(
      "normalizes equivalent instants for replay and keeps accepted policy",
      async () => {
        const first = await create("replay", {
          ...input,
          startsAt: "2030-01-02T11:00:00Z",
          endsAt: "2030-01-02T12:00:00Z",
        });
        const again = await create("replay", {
          ...input,
          startsAt: "2030-01-02T12:00:00+01:00",
          endsAt: "2030-01-02T13:00:00+01:00",
        });
        assert.equal(again.replayed, true);
        assert.deepEqual(again.result, first.result);
        assert.equal(first.result.calendarVersion, 1);
        assert.equal(first.result.timeZone, "Europe/Madrid");
        await migration.query(
          "UPDATE domain.municipality SET cancellation_minutes=60 WHERE id=$1",
          [tenant],
        );
        assert.equal(
          (
            await create("replay", {
              ...input,
              startsAt: "2030-01-02T11:00:00Z",
              endsAt: "2030-01-02T12:00:00Z",
            })
          ).result.cancellationMinutes,
          0,
        );
        const next = await create("new-policy", {
          ...input,
          startsAt: "2030-01-02T12:00:00Z",
          endsAt: "2030-01-02T13:00:00Z",
        });
        assert.equal(next.result.cancellationMinutes, 60);
      },
    );
    await t.test(
      "rejects invalid rules without leaving profiles, claims or events",
      async () => {
        const newcomer = {
          ...actor,
          accountId: "newcomer",
          email: "newcomer@example.test",
        };
        const cases = [
          { startsAt: "2030-01-03T10:00:00Z", endsAt: "2030-01-03T11:00:00Z" },
          { startsAt: "2030-02-01T10:00:00Z", endsAt: "2030-02-01T11:00:00Z" },
          { startsAt: "2029-12-31T10:00:00Z", endsAt: "2029-12-31T11:00:00Z" },
          { startsAt: "2030-01-04T10:15:00Z", endsAt: "2030-01-04T11:15:00Z" },
          { startsAt: "2030-01-04T16:30:00Z", endsAt: "2030-01-04T17:30:00Z" },
        ];
        for (const [i, range] of cases.entries())
          await assert.rejects(
            create(`invalid-${i}`, { ...input, ...range }, newcomer),
            { code: "CONFLICT" },
          );
        await assert.rejects(
          create(
            "duration",
            { ...input, endsAt: "2030-01-02T10:10:00Z" },
            newcomer,
          ),
          { code: "INVALID_INPUT" },
        );
        await assert.rejects(
          create("draft", { ...input, unitId: draft }, newcomer),
          { code: "NOT_FOUND" },
        );
        await assert.rejects(
          create("missing", { ...input, unitId: randomUUID() }, newcomer),
          { code: "NOT_FOUND" },
        );
        await assert.rejects(
          create("bad-time", { ...input, startsAt: "not-a-date" }, newcomer),
          { code: "INVALID_INPUT" },
        );
        await assert.rejects(
          create(
            "precision",
            { ...input, startsAt: "2030-01-02T10:00:00.000001Z" },
            newcomer,
          ),
          { code: "INVALID_INPUT" },
        );
        assert.equal(
          (
            await migration.query(
              "SELECT count(*)::int AS n FROM domain.municipal_profile WHERE account_id='newcomer'",
            )
          ).rows[0].n,
          0,
        );
        assert.equal(
          (
            await migration.query(
              "SELECT count(*)::int AS n FROM domain.idempotent_command WHERE actor_id='newcomer'",
            )
          ).rows[0].n,
          0,
        );
        const successful = await create(
          "newcomer",
          {
            ...input,
            startsAt: "2030-01-04T10:00:00Z",
            endsAt: "2030-01-04T11:00:00Z",
          },
          newcomer,
        );
        assert.equal(successful.result.revision, 1);
        assert.equal(
          (
            await migration.query(
              "SELECT count(*)::int AS n FROM domain.municipal_profile WHERE account_id='newcomer'",
            )
          ).rows[0].n,
          1,
        );
      },
    );
    await t.test(
      "modification preserves the original on conflict and versions successful changes without duplicate effects",
      async () => {
        const original = {
          ...input,
          startsAt: "2030-01-09T10:00:00Z",
          endsAt: "2030-01-09T11:00:00Z",
        };
        const destination = {
          ...input,
          startsAt: "2030-01-09T12:00:00Z",
          endsAt: "2030-01-09T13:00:00Z",
        };
        const booking = await create("modify-source", original);
        await create("modify-conflict", destination);
        const modify = (
          key: string,
          data = destination,
          revision = 1,
          now = "2030-01-01T00:00:00Z",
        ) =>
          modifyReservation(
            domain,
            actor,
            tenant,
            booking.result.id,
            key,
            { ...data, expectedRevision: revision },
            randomUUID(),
            3600,
            { now: () => new Date(now) },
          );
        await assert.rejects(modify("occupied"), { code: "CONFLICT" });
        const row = (
          await migration.query(
            "SELECT starts_at,revision FROM domain.reservation WHERE id=$1",
            [booking.result.id],
          )
        ).rows[0];
        assert.equal(row.starts_at.toISOString(), booking.result.startsAt);
        assert.equal(row.revision, 1);
        await assert.rejects(create("still-occupied", original), {
          code: "CONFLICT",
        });
        await assert.rejects(
          modify("late", destination, 1, "2030-01-09T09:00:00Z"),
          { code: "CONFLICT" },
        );
        await assert.rejects(modify("stale", original, 2), {
          code: "CONFLICT",
        });
        await assert.rejects(
          modify("draft-target", { ...destination, unitId: draft }),
          { code: "NOT_FOUND" },
        );
        const unchanged = await modify("unchanged", original);
        assert.equal(unchanged.result.revision, 1);
        assert.equal(
          (
            await migration.query(
              "SELECT count(*)::int AS n FROM domain.reservation_event WHERE reservation_id=$1",
              [booking.result.id],
            )
          ).rows[0].n,
          1,
        );
        const moved = {
          ...input,
          startsAt: "2030-01-09T14:00:00Z",
          endsAt: "2030-01-09T15:00:00Z",
        };
        const updated = await modify("move", moved);
        assert.equal(updated.result.revision, 2);
        const replay = await modify("move", moved);
        assert.equal(replay.replayed, true);
        assert.deepEqual(replay.result, updated.result);
        assert.equal(
          (await create("released-source", original)).result.status,
          "CONFIRMADA",
        );
        assert.equal(
          (
            await migration.query(
              "SELECT count(*)::int AS n FROM domain.reservation_event WHERE reservation_id=$1",
              [booking.result.id],
            )
          ).rows[0].n,
          2,
        );
        await migration.query(
          "UPDATE domain.reservable_unit SET published_at=now() WHERE tenant_id=$1 AND id=$2",
          [tenant, draft],
        );
        const changedUnit = await modify(
          "move-unit",
          { ...moved, unitId: draft },
          2,
        );
        assert.equal(changedUnit.result.unitId, draft);
        assert.equal(changedUnit.result.revision, 3);
        const concurrent = await Promise.allSettled([
          modify(
            "change-race-a",
            {
              ...moved,
              unitId: draft,
              startsAt: "2030-01-09T13:00:00Z",
              endsAt: "2030-01-09T14:00:00Z",
            },
            3,
          ),
          modify(
            "change-race-b",
            {
              ...moved,
              unitId: draft,
              startsAt: "2030-01-09T15:00:00Z",
              endsAt: "2030-01-09T16:00:00Z",
            },
            3,
          ),
        ]);
        assert.equal(
          concurrent.filter((r) => r.status === "fulfilled").length,
          1,
        );
        assert.ok(
          concurrent.some(
            (r) => r.status === "rejected" && r.reason.code === "CONFLICT",
          ),
        );
        await migration.query(
          "UPDATE domain.reservable_unit SET published_at=NULL WHERE tenant_id=$1 AND id=$2",
          [tenant, draft],
        );
        await cancelReservation(
          domain,
          actor,
          tenant,
          booking.result.id,
          "cancel-modified",
          { expectedRevision: 4 },
          randomUUID(),
          3600,
          clock,
        );
        await assert.rejects(modify("modify-cancelled", moved, 5), {
          code: "CONFLICT",
        });
      },
    );
    await t.test(
      "cancellation enforces accepted deadlines, revision and ownership and releases occupancy",
      async () => {
        const data = {
          ...input,
          startsAt: "2030-01-06T10:00:00Z",
          endsAt: "2030-01-06T11:00:00Z",
        };
        const booking = await create("to-cancel", data);
        const cancel = (
          key: string,
          revision = 1,
          now = "2030-01-06T08:59:59Z",
          who = actor,
          administrative = false,
        ) =>
          cancelReservation(
            domain,
            who,
            tenant,
            booking.result.id,
            key,
            {
              expectedRevision: revision,
              administrative,
              ...(administrative ? { reason: "Municipal intervention" } : {}),
            },
            randomUUID(),
            3600,
            { now: () => new Date(now) },
          );
        await assert.rejects(cancel("stale", 2), { code: "CONFLICT" });
        await assert.rejects(cancel("deadline", 1, "2030-01-06T09:00:00Z"), {
          code: "CONFLICT",
        });
        await assert.rejects(cancel("started", 1, "2030-01-06T10:00:00Z"), {
          code: "CONFLICT",
        });
        await assert.rejects(
          cancel("other", 1, undefined, { ...actor, accountId: "newcomer" }),
          { code: "NOT_FOUND" },
        );
        await assert.rejects(cancel("fake-admin", 1, undefined, actor, true), {
          code: "FORBIDDEN",
        });
        const cancelled = await cancel("cancel");
        assert.equal(cancelled.result.status, "CANCELADA");
        assert.equal(cancelled.result.revision, 2);
        assert.equal(
          (await cancel("cancel", 1, "2030-01-07T10:00:00Z")).replayed,
          true,
        );
        assert.equal(
          (await cancel("already-cancelled", 1, "2030-01-07T10:00:00Z")).result
            .revision,
          2,
        );
        const count = (
          await migration.query(
            "SELECT count(*)::int AS n FROM domain.reservation_event WHERE reservation_id=$1",
            [booking.result.id],
          )
        ).rows[0].n;
        assert.equal(count, 2);
        assert.equal(
          (
            await migration.query(
              "SELECT count(*)::int AS n FROM domain.occupancy WHERE reservation_id=$1 AND released_at IS NULL",
              [booking.result.id],
            )
          ).rows[0].n,
          0,
        );
        assert.equal(
          (await create("reuse-cancelled", data)).result.status,
          "CONFIRMADA",
        );
      },
    );
    await t.test(
      "administrative cancellation bypasses only the user deadline and rechecks revoked authority",
      async () => {
        const invitation = randomUUID();
        await migration.query(
          "INSERT INTO domain.administrator_invitation(tenant_id,id,account_id,invited_by,expires_at,accepted_at) VALUES($1,$2,'newcomer','citizen',now()+interval '1 day',now())",
          [tenant, invitation],
        );
        await migration.query(
          "INSERT INTO domain.municipal_administrator(tenant_id,account_id,invitation_id) VALUES($1,'newcomer',$2)",
          [tenant, invitation],
        );
        const admin = {
          ...actor,
          accountId: "newcomer",
          mfaVerifiedAt: new Date(),
        };
        const data = {
          ...input,
          startsAt: "2030-01-07T10:00:00Z",
          endsAt: "2030-01-07T11:00:00Z",
        };
        const booking = await create("admin-target", data);
        const cancel = (
          key: string,
          now = "2030-01-07T09:30:00Z",
          reason = "Maintenance",
        ) =>
          cancelReservation(
            domain,
            admin,
            tenant,
            booking.result.id,
            key,
            { expectedRevision: 1, administrative: true, reason },
            randomUUID(),
            3600,
            { now: () => new Date(now) },
          );
        await assert.rejects(cancel("missing-reason", undefined, ""), {
          code: "INVALID_INPUT",
        });
        await assert.rejects(
          cancel("already-started", "2030-01-07T10:00:00Z"),
          { code: "CONFLICT" },
        );
        const result = await cancel("admin-cancel");
        assert.equal(result.result.status, "CANCELADA");
        const event = (
          await migration.query(
            "SELECT actor_id,reason FROM domain.reservation_event WHERE reservation_id=$1 AND kind='CANCELADA'",
            [booking.result.id],
          )
        ).rows[0];
        assert.deepEqual(event, {
          actor_id: "newcomer",
          reason: "Maintenance",
        });
        await migration.query(
          "UPDATE domain.municipal_administrator SET revoked_at=now() WHERE tenant_id=$1 AND account_id='newcomer'",
          [tenant],
        );
        await assert.rejects(cancel("admin-cancel"), { code: "NOT_FOUND" });
      },
    );
    await t.test(
      "withdrawal prevents new bookings without hiding an authorized prior result",
      async () => {
        const data = {
          ...input,
          startsAt: "2030-01-05T10:00:00Z",
          endsAt: "2030-01-05T11:00:00Z",
        };
        const saved = await create("withdraw-replay", data);
        await migration.query(
          "UPDATE domain.facility SET withdrawn_at=now() WHERE tenant_id=$1 AND id=$2",
          [tenant, facility],
        );
        assert.deepEqual(
          (await create("withdraw-replay", data)).result,
          saved.result,
        );
        await assert.rejects(
          create("withdraw-new", {
            ...data,
            startsAt: "2030-01-05T11:00:00Z",
            endsAt: "2030-01-05T12:00:00Z",
          }),
          { code: "NOT_FOUND" },
        );
      },
    );
  });
});
