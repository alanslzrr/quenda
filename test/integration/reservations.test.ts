import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createReservation } from "../../src/modules/reservations/index.ts";
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
