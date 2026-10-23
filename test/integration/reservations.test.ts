import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { transaction } from "../../src/database/transaction.ts";
import {
  publicAvailability,
  saveUnitCalendar,
} from "../../src/modules/catalog/index.ts";
import {
  publicAvailabilitySearch,
  publicBookingDurations,
} from "../../src/modules/catalog/public.ts";
import {
  listOwnNotices,
  processReservationEmail,
} from "../../src/modules/communications/index.ts";
import {
  acceptManager,
  inviteManager,
  revokeManager,
} from "../../src/modules/identity/index.ts";
import {
  cancelReservation,
  createBlock,
  createReservation,
  listMunicipalReservations,
  listOwnReservations,
  modifyReservation,
  readReservation,
  releaseBlock,
} from "../../src/modules/reservations/index.ts";
import { withDatabase } from "../helpers/postgres.ts";
import {
  initialAcceptance,
  seedUsageRules,
} from "../helpers/usage-rules-fixture.ts";

test("reservation confirmation validates real calendars and commits every effect once", {
  timeout: 60000,
}, async (t) => {
  await withDatabase(async ({ domain, auth, migration, worker, root }) => {
    for (const id of ["citizen", "newcomer"])
      await auth.query(
        `INSERT INTO auth."user"(id,name,email,"emailVerified","twoFactorEnabled","createdAt","updatedAt") VALUES($1,$1,$2,true,true,now(),now())`,
        [id, `${id}@example.test`],
      );
    const tenant = randomUUID(),
      facility = randomUUID(),
      unit = randomUUID(),
      draft = randomUUID();
    await migration.query(
      "INSERT INTO domain.municipality(id,name,timezone,cancellation_minutes) VALUES($1,'Synthetic','Europe/Madrid',0)",
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
    for (const id of [unit, draft])
      await seedUsageRules(migration, tenant, id, "citizen");
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
        {
          acceptance: initialAcceptance,
          ...data,
        },
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
            {
              acceptance: initialAcceptance,
              ...data,
              expectedRevision: revision,
            },
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
          modify("late", destination, 1, "2030-01-09T09:00:00.001Z"),
          { code: "RESERVATION_DEADLINE_PASSED" },
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
        await assert.rejects(
          cancel("deadline", 1, "2030-01-06T09:00:00.001Z"),
          { code: "RESERVATION_DEADLINE_PASSED" },
        );
        await assert.rejects(cancel("started", 1, "2030-01-06T10:00:00Z"), {
          code: "RESERVATION_DEADLINE_PASSED",
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
          { code: "RESERVATION_DEADLINE_PASSED" },
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
      "block commands reject unresolved bookings and preserve audit on release and replay",
      async () => {
        const invitation = randomUUID();
        await migration.query(
          "INSERT INTO domain.administrator_invitation(tenant_id,id,account_id,invited_by,expires_at,accepted_at) VALUES($1,$2,'citizen','citizen',now()+interval '1 day',now())",
          [tenant, invitation],
        );
        await migration.query(
          "INSERT INTO domain.municipal_administrator(tenant_id,account_id,invitation_id) VALUES($1,'citizen',$2)",
          [tenant, invitation],
        );
        const admin = { ...actor, mfaVerifiedAt: new Date() };
        const data = {
          unitId: unit,
          startsAt: "2030-01-11T10:00:00Z",
          endsAt: "2030-01-11T11:00:00Z",
          reason: "Maintenance",
        };
        const block = (
          key: string,
          who: import("../../src/modules/identity/index.ts").AuthenticatedAccount = admin,
        ) => createBlock(domain, who, tenant, key, data, randomUUID(), 3600);
        await assert.rejects(block("no-mfa", actor), { code: "FORBIDDEN" });
        const booking = await create("block-conflict", data);
        await assert.rejects(block("over-booking"), {
          code: "CONFLICT",
        });
        assert.equal(
          (
            await migration.query(
              "SELECT count(*)::int AS n FROM domain.schedule_block",
            )
          ).rows[0].n,
          0,
        );
        await cancelReservation(
          domain,
          actor,
          tenant,
          booking.result.id,
          "resolve-block-conflict",
          { expectedRevision: 1 },
          randomUUID(),
          3600,
          clock,
        );
        const saved = await block("block");
        assert.equal(saved.result.releasedAt, null);
        assert.deepEqual((await block("block")).result, saved.result);
        await assert.rejects(block("over-block"), {
          code: "CONFLICT",
        });
        await assert.rejects(create("booking-over-block", data), {
          code: "CONFLICT",
        });
        const slots = await publicAvailability(
          domain,
          tenant,
          unit,
          "2030-01-11",
          60,
          clock,
        );
        assert.ok(
          !slots.slots.some((s) => s.start.utc === "2030-01-11T10:00:00.000Z"),
        );
        const release = (key: string) =>
          releaseBlock(
            domain,
            admin,
            tenant,
            saved.result.id,
            key,
            { reason: "Maintenance completed" },
            randomUUID(),
            3600,
          );
        const freed = await release("release");
        assert.ok(freed.result.releasedAt);
        assert.equal(freed.result.reason, "Maintenance");
        assert.deepEqual((await release("release")).result, freed.result);
        assert.deepEqual((await release("release-again")).result, freed.result);
        const events = (
          await migration.query(
            "SELECT operation,reason FROM domain.block_event WHERE block_id=$1 ORDER BY occurred_at",
            [saved.result.id],
          )
        ).rows;
        assert.deepEqual(events, [
          { operation: "CREATE", reason: "Maintenance" },
          { operation: "RELEASE", reason: "Maintenance completed" },
        ]);
        assert.equal(
          (await create("after-block-release", data)).result.status,
          "CONFIRMADA",
        );
        await migration.query(
          "UPDATE domain.municipal_administrator SET revoked_at=now() WHERE tenant_id=$1 AND account_id='citizen'",
          [tenant],
        );
        await assert.rejects(block("block"), { code: "FORBIDDEN" });
        await assert.rejects(release("release"), { code: "NOT_FOUND" });
      },
    );
    await t.test(
      "public availability follows committed creation, modification, cancellation and block release",
      async () => {
        const offered = async () => {
          const direct = await publicAvailability(
            domain,
            tenant,
            unit,
            "2030-01-10",
            60,
            clock,
          );
          const search = await publicAvailabilitySearch(
            domain,
            tenant,
            "2030-01-10",
            60,
            null,
            clock,
          );
          assert.deepEqual(
            search.items.find((item) => item.id === unit)?.slots ?? [],
            direct.slots,
          );
          assert.ok(search.items.every((item) => item.id !== draft));
          assert.deepEqual(
            (
              await publicAvailabilitySearch(
                domain,
                randomUUID(),
                "2030-01-10",
                60,
                null,
                clock,
              )
            ).items,
            [],
          );
          assert.deepEqual(
            (
              await publicAvailabilitySearch(
                domain,
                tenant,
                "2030-01-10",
                45,
                null,
                clock,
              )
            ).items,
            [],
          );
          assert.deepEqual(
            (await publicBookingDurations(domain, tenant)).durations,
            [30, 60, 90, 120],
          );
          return direct.slots.map((slot) => slot.start.utc);
        };
        const a = "2030-01-10T10:00:00.000Z",
          b = "2030-01-10T12:00:00.000Z";
        assert.ok((await offered()).includes(a));
        const booking = await create("availability-create", {
          unitId: unit,
          startsAt: a,
          endsAt: "2030-01-10T11:00:00Z",
        });
        const afterCreate = await offered();
        assert.ok(!afterCreate.includes(a));
        assert.ok(!afterCreate.includes("2030-01-10T09:30:00.000Z"));
        assert.ok(afterCreate.includes("2030-01-10T09:00:00.000Z"));
        assert.ok(afterCreate.includes("2030-01-10T11:00:00.000Z"));
        await modifyReservation(
          domain,
          actor,
          tenant,
          booking.result.id,
          "availability-move",
          {
            acceptance: initialAcceptance,
            expectedRevision: 1,
            unitId: unit,
            startsAt: b,
            endsAt: "2030-01-10T13:00:00Z",
          },
          randomUUID(),
          3600,
          clock,
        );
        assert.ok((await offered()).includes(a));
        assert.ok(!(await offered()).includes(b));
        await cancelReservation(
          domain,
          actor,
          tenant,
          booking.result.id,
          "availability-cancel",
          { expectedRevision: 2 },
          randomUUID(),
          3600,
          clock,
        );
        assert.ok((await offered()).includes(b));
        const block = randomUUID();
        const insertBlock = async (c: import("pg").PoolClient) => {
          await c.query(
            "INSERT INTO domain.schedule_block(tenant_id,id,unit_id,starts_at,ends_at,actor_id,reason) VALUES($1,$2,$3,$4,'2030-01-10T11:00:00Z','citizen','Fixture')",
            [tenant, block, unit, a],
          );
          await c.query(
            "INSERT INTO domain.occupancy(tenant_id,id,unit_id,block_id,period) VALUES($1,$2,$3,$4,tstzrange($5,'2030-01-10T11:00:00Z','[)'))",
            [tenant, randomUUID(), unit, block, a],
          );
        };
        await assert.rejects(
          transaction(migration, async (c) => {
            await insertBlock(c);
            throw new Error("Abort block");
          }),
          /Abort block/,
        );
        assert.ok((await offered()).includes(a));
        await transaction(migration, async (c) => {
          await insertBlock(c);
          assert.ok((await offered()).includes(a));
        });
        assert.ok(!(await offered()).includes(a));
        await transaction(migration, async (c) => {
          await c.query(
            "UPDATE domain.schedule_block SET released_at=now() WHERE tenant_id=$1 AND id=$2",
            [tenant, block],
          );
          await c.query(
            "UPDATE domain.occupancy SET released_at=now() WHERE tenant_id=$1 AND block_id=$2",
            [tenant, block],
          );
        });
        assert.ok((await offered()).includes(a));
        assert.equal(
          (
            await migration.query(
              "SELECT count(*)::int AS n FROM domain.occupancy WHERE block_id=$1",
              [block],
            )
          ).rows[0].n,
          1,
        );
        const hidden = await domain.query(
          "SELECT * FROM domain.public_available_slots($1,$2,ARRAY[$3::timestamptz],ARRAY[$4::timestamptz])",
          [tenant, draft, a, "2030-01-10T11:00:00Z"],
        );
        assert.equal(hidden.rowCount, 0);
        const foreign = await domain.query(
          "SELECT * FROM domain.public_available_slots($1,$2,ARRAY[$3::timestamptz],ARRAY[$4::timestamptz])",
          [randomUUID(), unit, a, "2030-01-10T11:00:00Z"],
        );
        assert.equal(foreign.rowCount, 0);
      },
    );
    await t.test(
      "calendar edits reject incompatible confirmed reservations without changing accepted policy",
      async () => {
        const invitation = randomUUID();
        await migration.query(
          "INSERT INTO domain.administrator_invitation(tenant_id,id,account_id,invited_by,expires_at,accepted_at) VALUES($1,$2,'citizen','citizen',now()+interval '1 day',now())",
          [tenant, invitation],
        );
        await migration.query(
          "UPDATE domain.municipal_administrator SET revoked_at=NULL,granted_at=now(),invitation_id=$2 WHERE tenant_id=$1 AND account_id='citizen'",
          [tenant, invitation],
        );
        const admin = { ...actor, mfaVerifiedAt: new Date() };
        const data = {
          ...input,
          startsAt: "2030-01-12T10:00:00Z",
          endsAt: "2030-01-12T11:00:00Z",
        };
        const booking = await create("calendar-protected", data);
        const calendar = {
          minimumMinutes: 30,
          maximumMinutes: 120,
          stepMinutes: 30,
          advanceDays: null,
          weekly,
          exceptions: [{ date: "2030-01-03", intervals: [] }],
        };
        const closed = {
          ...calendar,
          exceptions: [
            ...calendar.exceptions,
            { date: "2030-01-12", intervals: [] },
          ],
        };
        await assert.rejects(
          saveUnitCalendar(domain, admin, tenant, unit, {
            expectedVersion: 1,
            reason: "Closure",
            calendar: closed,
          }),
          { code: "CONFLICT" },
        );
        assert.equal(
          (
            await migration.query(
              "SELECT calendar_version FROM domain.reservable_unit WHERE id=$1",
              [unit],
            )
          ).rows[0].calendar_version,
          1,
        );
        assert.equal(
          (
            await migration.query(
              "SELECT count(*)::int AS n FROM domain.unit_calendar_version WHERE unit_id=$1",
              [unit],
            )
          ).rows[0].n,
          1,
        );
        const changedPolicy = await saveUnitCalendar(
          domain,
          admin,
          tenant,
          unit,
          {
            expectedVersion: 1,
            reason: "Future duration policy",
            calendar: { ...calendar, minimumMinutes: 120 },
          },
        );
        assert.equal(changedPolicy.version, 2);
        const existing = (
          await migration.query(
            "SELECT calendar_version,ends_at-starts_at AS duration FROM domain.reservation WHERE id=$1",
            [booking.result.id],
          )
        ).rows[0];
        assert.equal(existing.calendar_version, 1);
        await assert.rejects(
          saveUnitCalendar(domain, admin, tenant, unit, {
            expectedVersion: 2,
            reason: "Still occupied",
            calendar: closed,
          }),
          { code: "CONFLICT" },
        );
        await cancelReservation(
          domain,
          actor,
          tenant,
          booking.result.id,
          "resolve-calendar",
          { expectedRevision: 1 },
          randomUUID(),
          3600,
          clock,
        );
        const saved = await saveUnitCalendar(domain, admin, tenant, unit, {
          expectedVersion: 2,
          reason: "Resolved closure",
          calendar: closed,
        });
        assert.equal(saved.version, 3);
        assert.equal(
          (
            await publicAvailability(
              domain,
              tenant,
              unit,
              "2030-01-12",
              60,
              clock,
            )
          ).slots.length,
          0,
        );
        await assert.rejects(create("closed-calendar", data), {
          code: "CONFLICT",
        });
      },
    );
    await t.test(
      "a concurrent closure and new reservation cannot both commit",
      async () => {
        const admin = { ...actor, mfaVerifiedAt: new Date() };
        const calendar = {
          minimumMinutes: 30,
          maximumMinutes: 120,
          stepMinutes: 30,
          advanceDays: null,
          weekly,
          exceptions: [
            { date: "2030-01-03", intervals: [] },
            { date: "2030-01-12", intervals: [] },
            { date: "2030-01-13", intervals: [] },
          ],
        };
        const results = await Promise.allSettled([
          create("calendar-race", {
            ...input,
            startsAt: "2030-01-13T10:00:00Z",
            endsAt: "2030-01-13T11:00:00Z",
          }),
          saveUnitCalendar(domain, admin, tenant, unit, {
            expectedVersion: 3,
            reason: "Concurrent closure",
            calendar,
          }),
        ]);
        assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
        assert.ok(
          results.some(
            (r) => r.status === "rejected" && r.reason.code === "CONFLICT",
          ),
        );
        const version = (
          await migration.query(
            "SELECT calendar_version FROM domain.reservable_unit WHERE id=$1",
            [unit],
          )
        ).rows[0].calendar_version;
        await saveUnitCalendar(domain, admin, tenant, unit, {
          expectedVersion: version,
          reason: "Restore opening",
          calendar: {
            ...calendar,
            exceptions: calendar.exceptions.filter(
              (e) => e.date !== "2030-01-13",
            ),
          },
        });
      },
    );
    await t.test(
      "own history crosses municipalities without exposing another account and municipal lists keep permission scope",
      async () => {
        for (let i = 0; i < 22; i++) {
          const start = new Date(
            `2030-01-${14 + Math.floor(i / 16)}T08:00:00Z`,
          );
          start.setUTCMinutes(start.getUTCMinutes() + (i % 16) * 30);
          await create(`history-${i}`, {
            unitId: unit,
            startsAt: start.toISOString(),
            endsAt: new Date(start.getTime() + 1800000).toISOString(),
          });
        }
        const otherTenant = randomUUID(),
          otherFacility = randomUUID(),
          otherUnit = randomUUID();
        await migration.query(
          "INSERT INTO domain.municipality(id,name,timezone,cancellation_minutes) VALUES($1,'Second municipality','Europe/Madrid',0)",
          [otherTenant],
        );
        await migration.query(
          "INSERT INTO domain.facility(tenant_id,id,name,published_at) VALUES($1,$2,'Second facility',now())",
          [otherTenant, otherFacility],
        );
        await migration.query(
          "INSERT INTO domain.reservable_unit(tenant_id,id,facility_id,name) VALUES($1,$2,$3,'Second unit')",
          [otherTenant, otherUnit, otherFacility],
        );
        await migration.query(
          "INSERT INTO domain.unit_calendar_version(tenant_id,unit_id,version,minimum_minutes,maximum_minutes,step_minutes,weekly,exceptions,actor_id,reason) VALUES($1,$2,1,30,120,30,$3,'[]','citizen','Fixture')",
          [otherTenant, otherUnit, JSON.stringify(weekly)],
        );
        await seedUsageRules(migration, otherTenant, otherUnit, "citizen");
        await migration.query(
          "UPDATE domain.reservable_unit SET calendar_version=1,published_at=now() WHERE tenant_id=$1 AND id=$2",
          [otherTenant, otherUnit],
        );
        const cross = await createReservation(
          domain,
          actor,
          otherTenant,
          "other-municipality",
          {
            acceptance: initialAcceptance,
            unitId: otherUnit,
            startsAt: "2030-01-14T10:00:00Z",
            endsAt: "2030-01-14T11:00:00Z",
          },
          randomUUID(),
          3600,
          clock,
        );
        await migration.query(
          "UPDATE domain.reservable_unit SET withdrawn_at=now() WHERE tenant_id=$1 AND id=$2",
          [otherTenant, otherUnit],
        );
        const detail = await readReservation(
          domain,
          actor,
          otherTenant,
          cross.result.id,
          clock,
        );
        assert.equal(detail.status, "CONFIRMADA");
        assert.equal(detail.accountId, actor.accountId);
        await assert.rejects(
          readReservation(
            domain,
            { ...actor, accountId: "newcomer" },
            otherTenant,
            cross.result.id,
          ),
          { code: "NOT_FOUND" },
        );
        await assert.rejects(
          readReservation(domain, actor, tenant, cross.result.id),
          { code: "NOT_FOUND" },
        );
        assert.equal(
          (
            await readReservation(domain, actor, otherTenant, cross.result.id, {
              now: () => new Date(detail.endsAt),
            })
          ).status,
          "FINALIZADA",
        );
        const all = [];
        let after: string | null = null;
        do {
          const page = await listOwnReservations(
            domain,
            actor,
            { after },
            {
              now: () => new Date("2031-01-01T00:00:00Z"),
            },
          );
          assert.ok(page.items.length <= 20);
          all.push(...page.items);
          after = page.nextCursor;
        } while (after);
        const expected = (
          await migration.query(
            "SELECT count(*)::int AS n FROM domain.reservation WHERE account_id='citizen'",
          )
        ).rows[0].n;
        assert.equal(all.length, expected);
        assert.equal(
          new Set(all.map((r) => `${r.tenantId}:${r.id}`)).size,
          expected,
        );
        assert.ok(
          all.some(
            (r) =>
              r.id === cross.result.id &&
              r.municipality === "Second municipality",
          ),
        );
        assert.ok(all.some((r) => r.status === "FINALIZADA"));
        assert.ok(all.some((r) => r.status === "CANCELADA"));
        assert.equal(
          (
            await migration.query(
              "SELECT count(*)::int AS n FROM domain.reservation WHERE status='FINALIZADA'",
            )
          ).rows[0].n,
          0,
        );
        const notices = [];
        let noticeCursor: string | null = null;
        do {
          const page = await listOwnNotices(domain, actor, noticeCursor);
          assert.ok(page.items.length <= 20);
          notices.push(...page.items);
          noticeCursor = page.nextCursor;
        } while (noticeCursor);
        const expectedNotices = (
          await migration.query(
            "SELECT count(*)::int AS n FROM domain.reservation_notice WHERE account_id='citizen'",
          )
        ).rows[0].n;
        assert.equal(notices.length, expectedNotices);
        assert.equal(
          new Set(notices.map((n) => n.eventId)).size,
          expectedNotices,
        );
        assert.ok(notices.some((n) => n.reservationId === cross.result.id));
        assert.ok(notices.some((n) => n.kind === "CANCELADA"));
        assert.ok(
          notices.every(
            (n) => !("actorId" in n) && !("reason" in n) && !("accountId" in n),
          ),
        );
        assert.equal(
          (
            await domain.query(
              "SELECT * FROM domain.own_reservation_notices(NULL,NULL)",
            )
          ).rowCount,
          0,
        );
        await assert.rejects(listOwnNotices(domain, actor, "invalid"), {
          code: "INVALID_INPUT",
        });
        const newcomer = { ...actor, accountId: "newcomer" };
        const own = await listOwnReservations(domain, newcomer);
        const ids = new Set(
          (
            await migration.query(
              "SELECT id FROM domain.reservation WHERE account_id='newcomer'",
            )
          ).rows.map((r) => r.id),
        );
        assert.ok(own.items.every((r) => ids.has(r.id)));
        const newcomerNotices = await listOwnNotices(domain, newcomer);
        assert.ok(newcomerNotices.items.length > 0);
        assert.ok(newcomerNotices.items.every((n) => ids.has(n.reservationId)));

        assert.ok(own.items.length > 0);
        const exactEnd = own.items[0]?.endsAt;
        assert.ok(exactEnd);
        const completed = await listOwnReservations(
          domain,
          newcomer,
          {},
          {
            now: () => new Date(exactEnd),
          },
        );
        assert.equal(completed.items[0]?.status, "FINALIZADA");
        assert.ok(own.items.every((r) => !("accountId" in r)));
        await assert.rejects(
          listOwnReservations(domain, actor, { after: "invalid-cursor" }),
          { code: "INVALID_INPUT" },
        );
        assert.equal(
          (
            await domain.query(
              "SELECT * FROM domain.own_reservations(NULL,NULL)",
            )
          ).rowCount,
          0,
        );
        await assert.rejects(listMunicipalReservations(domain, actor, tenant), {
          code: "FORBIDDEN",
        });
        assert.deepEqual(
          (
            await listMunicipalReservations(
              domain,
              { ...newcomer, mfaVerifiedAt: new Date() },
              tenant,
            )
          ).items,
          [],
        );
        const admin = { ...actor, mfaVerifiedAt: new Date() };
        const page = await listMunicipalReservations(domain, admin, tenant);
        assert.equal(page.items.length, 20);
        assert.ok(page.nextCursor);
        assert.ok(page.items.every((r) => r.tenantId === tenant));
        const auditedPage = (
          await migration.query(
            "SELECT reservation_id,actor_id,operation,correlation_id FROM domain.reservation_read_event WHERE tenant_id=$1",
            [tenant],
          )
        ).rows;
        assert.deepEqual(
          auditedPage.map((row) => row.reservation_id).sort(),
          page.items.map((row) => row.id).sort(),
        );
        assert.ok(
          auditedPage.every(
            (row) =>
              row.actor_id === admin.accountId &&
              row.operation === "MUNICIPAL_LIST",
          ),
        );
        assert.equal(
          new Set(auditedPage.map((row) => row.correlation_id)).size,
          1,
        );
        for (const runtime of [domain, auth, worker])
          await assert.rejects(
            runtime.query("SELECT * FROM domain.reservation_read_event"),
            { code: "42501" },
          );
        await assert.rejects(
          domain.query(
            "SELECT domain.record_reservation_reads($1,'DETAIL',$2)",
            [[page.items[0]?.id], randomUUID()],
          ),
          { code: "42501" },
        );

        assert.deepEqual(
          (await listMunicipalReservations(domain, admin, otherTenant)).items,
          [],
        );
        const scoped = { ...newcomer, mfaVerifiedAt: new Date() };
        const invitation = await inviteManager(domain, admin, tenant, {
          accountId: newcomer.accountId,
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
          permissions: [{ operation: "RESERVATION_READ", unitId: draft }],
        });
        await acceptManager(domain, scoped, tenant, invitation.invitationId);
        const scopedPage = await listMunicipalReservations(
          domain,
          scoped,
          tenant,
        );
        assert.ok(scopedPage.items.length > 0);
        assert.ok(scopedPage.items.every((r) => r.unitId === draft));
        assert.deepEqual(
          (
            await listMunicipalReservations(domain, scoped, tenant, {
              unitId: unit,
            })
          ).items,
          [],
        );
        const scopedId = scopedPage.items[0]?.id;
        assert.ok(scopedId);
        assert.equal(
          (await readReservation(domain, scoped, tenant, scopedId)).unitId,
          draft,
        );
        await assert.rejects(
          readReservation(
            domain,
            { ...scoped, mfaVerifiedAt: null },
            tenant,
            scopedId,
          ),
          { code: "FORBIDDEN" },
        );
        const detailEvents = (
          await migration.query(
            "SELECT actor_id FROM domain.reservation_read_event WHERE tenant_id=$1 AND reservation_id=$2 AND operation='DETAIL'",
            [tenant, scopedId],
          )
        ).rows;
        assert.ok(
          detailEvents.some((row) => row.actor_id === scoped.accountId),
        );
        const auditCount = async () =>
          (
            await migration.query(
              "SELECT count(*)::int AS n FROM domain.reservation_read_event",
            )
          ).rows[0].n;
        const beforeAuditFailure = await auditCount();
        await migration.query(
          "CREATE FUNCTION domain.fail_read_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic audit failure' USING ERRCODE='23514'; END $$; CREATE TRIGGER fail_read_audit BEFORE INSERT ON domain.reservation_read_event FOR EACH ROW EXECUTE FUNCTION domain.fail_read_audit()",
        );
        try {
          await assert.rejects(
            listMunicipalReservations(domain, admin, tenant),
            { code: "23514" },
          );
        } finally {
          await migration.query(
            "DROP TRIGGER fail_read_audit ON domain.reservation_read_event; DROP FUNCTION domain.fail_read_audit()",
          );
        }
        assert.equal(await auditCount(), beforeAuditFailure);
        await revokeManager(
          domain,
          admin,
          tenant,
          invitation.invitationId,
          "Remove access",
        );
        assert.deepEqual(
          (await listMunicipalReservations(domain, scoped, tenant)).items,
          [],
        );
        await assert.rejects(
          readReservation(domain, scoped, tenant, scopedId),
          { code: "NOT_FOUND" },
        );
        const temporary = await inviteManager(domain, admin, tenant, {
          accountId: scoped.accountId,
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
          roleExpiresAt: new Date(Date.now() + 5000).toISOString(),
          permissions: [{ operation: "RESERVATION_READ", unitId: draft }],
        });
        await acceptManager(domain, scoped, tenant, temporary.invitationId);
        const supportCorrelation = randomUUID();
        await readReservation(
          domain,
          scoped,
          tenant,
          scopedId,
          undefined,
          supportCorrelation,
        );
        assert.equal(
          (
            await migration.query(
              "SELECT count(*)::int AS n FROM domain.reservation_read_event WHERE correlation_id=$1 AND actor_id=$2 AND reservation_id=$3",
              [supportCorrelation, scoped.accountId, scopedId],
            )
          ).rows[0].n,
          1,
        );
        const beforeExpiry = await auditCount();
        // Wait for the stored database deadline, not an estimated arbitrary delay.
        await migration.query(
          "SELECT pg_sleep(greatest(0,extract(epoch FROM role_expires_at-clock_timestamp()))::double precision+0.01) FROM domain.manager_invitation WHERE tenant_id=$1 AND id=$2",
          [tenant, temporary.invitationId],
        );
        assert.equal(
          (
            await migration.query(
              "SELECT role_expires_at<=clock_timestamp() AS expired FROM domain.manager_invitation WHERE tenant_id=$1 AND id=$2",
              [tenant, temporary.invitationId],
            )
          ).rows[0].expired,
          true,
        );
        assert.deepEqual(
          (await listMunicipalReservations(domain, scoped, tenant)).items,
          [],
        );
        await assert.rejects(
          readReservation(domain, scoped, tenant, scopedId),
          { code: "NOT_FOUND" },
        );
        await assert.rejects(
          transaction(
            domain,
            async (client) => {
              await client.query(
                "SELECT domain.record_reservation_reads($1,'DETAIL',$2)",
                [[scopedId], randomUUID()],
              );
            },
            { accountId: scoped.accountId, tenantId: tenant },
          ),
          { code: "42501" },
        );
        assert.equal(await auditCount(), beforeExpiry);
        assert.deepEqual(
          (
            await migration.query(
              "SELECT operation FROM domain.manager_event WHERE tenant_id=$1 AND invitation_id=$2 ORDER BY operation",
              [tenant, temporary.invitationId],
            )
          ).rows.map((row) => row.operation),
          ["ACCEPT_MANAGER", "INVITE_MANAGER"],
        );
        assert.equal(
          (
            await migration.query(
              "SELECT revoked_at FROM domain.manager_grant WHERE tenant_id=$1 AND invitation_id=$2",
              [tenant, temporary.invitationId],
            )
          ).rows[0].revoked_at,
          null,
        );
        const filtered = await listMunicipalReservations(
          domain,
          admin,
          tenant,
          { unitId: draft },
        );
        assert.ok(filtered.items.every((r) => r.unitId === draft));
      },
    );
    await t.test(
      "administrative modification requires source and destination scope and cannot bypass integrity or start",
      async () => {
        const admin = { ...actor, mfaVerifiedAt: new Date() };
        const manager = {
          ...actor,
          accountId: "newcomer",
          email: "newcomer@example.test",
          mfaVerifiedAt: new Date(),
        };
        await migration.query(
          "UPDATE domain.reservable_unit SET published_at=now() WHERE tenant_id=$1 AND id=$2",
          [tenant, draft],
        );
        const source = {
          unitId: unit,
          startsAt: "2030-01-18T10:00:00Z",
          endsAt: "2030-01-18T11:00:00Z",
        };
        const target = {
          unitId: draft,
          startsAt: "2030-01-18T11:00:00Z",
          endsAt: "2030-01-18T12:00:00Z",
        };
        const booking = await create("managed-move-source", source);
        const grant = async (units: string[]) => {
          const invited = await inviteManager(domain, admin, tenant, {
            accountId: manager.accountId,
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
            permissions: units.map((unitId) => ({
              operation: "RESERVATION_MANAGE" as const,
              unitId,
            })),
          });
          await acceptManager(domain, manager, tenant, invited.invitationId);
          return invited.invitationId;
        };
        const move = (
          key: string,
          data = target,
          revision = 1,
          now = "2030-01-18T09:30:00Z",
          reason = "Relocation",
        ) =>
          modifyReservation(
            domain,
            manager,
            tenant,
            booking.result.id,
            key,
            {
              ...data,
              expectedRevision: revision,
              administrative: true,
              reason,
            },
            randomUUID(),
            3600,
            { now: () => new Date(now) },
          );
        const sourceOnly = await grant([unit]);
        await assert.rejects(move("source-only"), { code: "FORBIDDEN" });
        await revokeManager(domain, admin, tenant, sourceOnly, "Change scope");
        const destinationOnly = await grant([draft]);
        await assert.rejects(move("destination-only"), { code: "NOT_FOUND" });
        await revokeManager(
          domain,
          admin,
          tenant,
          destinationOnly,
          "Change scope",
        );
        const both = await grant([unit, draft]);
        await assert.rejects(move("no-reason", target, 1, undefined, ""), {
          code: "INVALID_INPUT",
        });
        await assert.rejects(
          move("already-started", target, 1, "2030-01-18T10:00:00Z"),
          { code: "RESERVATION_DEADLINE_PASSED" },
        );
        const before = (
          await migration.query(
            "SELECT revision,unit_id FROM domain.reservation WHERE id=$1",
            [booking.result.id],
          )
        ).rows[0];
        assert.deepEqual(before, { revision: 1, unit_id: unit });
        const changed = await move("authorized-move");
        assert.equal(changed.result.unitId, draft);
        assert.equal(changed.result.revision, 2);
        assert.equal(changed.result.usageRulesUnitId, unit);
        assert.equal(changed.result.usageRulesVersion, 1);
        assert.equal(changed.result.pendingUsageRulesVersion, 1);
        assert.equal(
          changed.result.rulesAcceptedAt,
          booking.result.rulesAcceptedAt,
        );
        const event = (
          await migration.query(
            "SELECT actor_id,reason FROM domain.reservation_event WHERE reservation_id=$1 AND kind='MODIFICADA'",
            [booking.result.id],
          )
        ).rows[0];
        assert.deepEqual(event, { actor_id: "newcomer", reason: "Relocation" });
        const occupied = {
          unitId: unit,
          startsAt: "2030-01-18T12:00:00Z",
          endsAt: "2030-01-18T13:00:00Z",
        };
        await create("managed-move-occupied", occupied);
        await assert.rejects(move("admin-conflict", occupied, 2), {
          code: "CONFLICT",
        });
        assert.equal(
          (
            await readReservation(
              domain,
              actor,
              tenant,
              booking.result.id,
              clock,
            )
          ).revision,
          2,
        );
        await revokeManager(domain, admin, tenant, both, "Remove permission");
        await assert.rejects(move("authorized-move"), {
          code: "NOT_FOUND",
        });
      },
    );
    await t.test(
      "concurrent block and reservation commands have one winner and no partial loser",
      async () => {
        const admin = { ...actor, mfaVerifiedAt: new Date() };
        for (let i = 0; i < 5; i++) {
          const start = new Date("2030-01-19T08:00:00Z");
          start.setUTCHours(start.getUTCHours() + i);
          const interval = {
            unitId: unit,
            startsAt: start.toISOString(),
            endsAt: new Date(start.getTime() + 3600000).toISOString(),
          };
          const outcomes = await Promise.allSettled([
            create(`closure-race-booking-${i}`, interval),
            createBlock(
              domain,
              admin,
              tenant,
              `closure-race-block-${i}`,
              { ...interval, reason: "Concurrent closure" },
              randomUUID(),
              3600,
            ),
          ]);
          assert.equal(
            outcomes.filter((r) => r.status === "fulfilled").length,
            1,
          );
          assert.ok(
            outcomes.some(
              (r) => r.status === "rejected" && r.reason.code === "CONFLICT",
            ),
          );
          const rows = (
            await migration.query(
              "SELECT reservation_id,block_id FROM domain.occupancy WHERE tenant_id=$1 AND unit_id=$2 AND released_at IS NULL AND period && tstzrange($3,$4,'[)')",
              [tenant, unit, interval.startsAt, interval.endsAt],
            )
          ).rows;
          assert.equal(rows.length, 1);
          assert.notEqual(
            rows[0].reservation_id === null,
            rows[0].block_id === null,
          );
          const claims = (
            await migration.query(
              "SELECT count(*)::int AS n FROM domain.idempotent_command WHERE tenant_id=$1 AND key IN ($2,$3)",
              [tenant, `closure-race-booking-${i}`, `closure-race-block-${i}`],
            )
          ).rows[0].n;
          assert.equal(claims, 1);
        }
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
    await t.test(
      "outbox leases fence stale workers, preserve ordering and bound retries",
      async () => {
        const claim = async () =>
          (
            await worker.query(
              "SELECT * FROM domain.claim_reservation_email(30,3)",
            )
          ).rows;
        const finish = async (token: string, accepted: boolean) =>
          (
            await worker.query(
              "SELECT domain.finish_reservation_email($1,$2,3,60) AS saved",
              [token, accepted],
            )
          ).rows[0].saved;
        for (const pool of [domain, auth]) {
          await assert.rejects(
            pool.query("SELECT * FROM domain.reservation_email_health()"),
            { code: "42501" },
          );
          await assert.rejects(
            pool.query("SELECT * FROM domain.claim_reservation_email(30,3)"),
            { code: "42501" },
          );
          await assert.rejects(
            pool.query("SELECT domain.finish_reservation_email($1,true,3,60)", [
              randomUUID(),
            ]),
            { code: "42501" },
          );
        }
        for (const table of [
          "reservation",
          "reservation_email",
          "reservation_email_attempt",
        ])
          await assert.rejects(worker.query(`SELECT * FROM domain.${table}`), {
            code: "42501",
          });
        await assert.rejects(worker.query('SELECT * FROM auth."user"'), {
          code: "42501",
        });
        await assert.rejects(
          worker.query("SELECT * FROM domain.claim_reservation_email(0,3)"),
          { code: "23514" },
        );
        const [one, two] = await Promise.all([claim(), claim()]);
        const first = one[0],
          second = two[0];
        assert.ok(first && second);
        assert.notEqual(first.event_id, second.event_id);
        assert.notEqual(first.reservation_id, second.reservation_id);
        assert.equal(first.attempt, 1);
        assert.equal(first.revision, 1);
        assert.match(first.recipient, /@example.test$/);
        assert.equal(await finish(second.token, true), true);
        assert.equal(await finish(second.token, true), false);
        await migration.query(
          "UPDATE domain.reservation_email SET next_attempt_at=now()+interval '1 day' WHERE accepted_at IS NULL",
        );
        assert.equal(await finish(first.token, false), true);
        assert.equal((await claim()).length, 0);
        await migration.query(
          "UPDATE domain.reservation_email SET next_attempt_at=now()-interval '1 second' WHERE tenant_id=$1 AND event_id=$2",
          [first.tenant_id, first.event_id],
        );
        const retried = (await claim())[0];
        assert.equal(retried.event_id, first.event_id);
        assert.equal(retried.attempt, 2);
        assert.notEqual(retried.token, first.token);
        await migration.query(
          "UPDATE domain.reservation_email SET lease_until=now()-interval '1 second' WHERE tenant_id=$1 AND event_id=$2",
          [first.tenant_id, first.event_id],
        );
        assert.equal(await finish(retried.token, true), false);
        const recovered = (await claim())[0];
        assert.equal(recovered.event_id, first.event_id);
        assert.equal(recovered.attempt, 3);
        assert.equal(await finish(retried.token, true), false);
        assert.equal(await finish(recovered.token, false), true);
        assert.equal((await claim()).length, 0);
        assert.deepEqual(
          (
            await migration.query(
              "SELECT outcome FROM domain.reservation_email_attempt WHERE tenant_id=$1 AND event_id=$2 ORDER BY attempt",
              [first.tenant_id, first.event_id],
            )
          ).rows.map((r) => r.outcome),
          ["FAILED", "EXPIRED", "FAILED"],
        );
        assert.equal(
          (
            await migration.query(
              "SELECT exhausted_at IS NOT NULL AS exhausted,accepted_at IS NULL AS unaccepted FROM domain.reservation_email WHERE tenant_id=$1 AND event_id=$2",
              [first.tenant_id, first.event_id],
            )
          ).rows[0].exhausted,
          true,
        );
        await migration.query(
          "UPDATE domain.reservation_email SET next_attempt_at=now()-interval '1 second' WHERE accepted_at IS NULL AND exhausted_at IS NULL",
        );
        const revisions = new Map<string, number>([
          [first.reservation_id, 1],
          [second.reservation_id, 1],
        ]);
        const workerOptions = {
          origin: "https://quenda.test",
          locale: "es" as const,
          leaseSeconds: 30,
          maxAttempts: 3,
          retrySeconds: 60,
        };
        assert.equal(
          await processReservationEmail(
            worker,
            {
              send: async () => {
                throw new Error("Sensitive provider error");
              },
            },
            workerOptions,
          ),
          "RETRY_SCHEDULED",
        );
        await migration.query(
          "UPDATE domain.reservation_email SET next_attempt_at=now()-interval '1 second' WHERE accepted_at IS NULL AND exhausted_at IS NULL",
        );
        const limited = (
          await migration.query(
            "SELECT q.tenant_id,q.event_id,e.reservation_id,e.revision FROM domain.reservation_email q JOIN domain.reservation_event e ON (e.tenant_id,e.id)=(q.tenant_id,q.event_id) WHERE q.attempts=1 AND q.accepted_at IS NULL AND q.exhausted_at IS NULL AND q.lease_token IS NULL",
          )
        ).rows;
        assert.equal(limited.length, 1);
        await migration.query(
          "UPDATE domain.reservation_email SET next_attempt_at=now()+interval '1 day' WHERE accepted_at IS NULL AND exhausted_at IS NULL",
        );
        assert.equal(
          (
            await worker.query(
              "SELECT * FROM domain.claim_reservation_email(30,1)",
            )
          ).rowCount,
          0,
        );
        const terminal = (
          await migration.query(
            "SELECT attempts,exhausted_at IS NOT NULL AS exhausted,accepted_at IS NULL AS unaccepted FROM domain.reservation_email WHERE tenant_id=$1 AND event_id=$2",
            [limited[0].tenant_id, limited[0].event_id],
          )
        ).rows[0];
        assert.deepEqual(terminal, {
          attempts: 1,
          exhausted: true,
          unaccepted: true,
        });
        revisions.set(limited[0].reservation_id, limited[0].revision);
        await migration.query(
          "UPDATE domain.reservation_email SET next_attempt_at=now()-interval '1 second' WHERE accepted_at IS NULL AND exhausted_at IS NULL",
        );
        let processed = 0;
        while (true) {
          const outcome = await processReservationEmail(
            worker,
            {
              send: async (message) => {
                assert.equal(
                  (
                    await migration.query(
                      "SELECT count(*)::int AS n FROM domain.reservation_email WHERE lease_token IS NOT NULL",
                    )
                  ).rows[0].n,
                  1,
                );
                const reservation = /Reserva: ([0-9a-f-]+)/.exec(
                  message.text,
                )?.[1];
                const revision = Number(
                  /Revisión: (\d+)/.exec(message.text)?.[1],
                );
                assert.ok(reservation);
                assert.equal(revision, (revisions.get(reservation) ?? 0) + 1);
                revisions.set(reservation, revision);
              },
            },
            workerOptions,
          );
          if (outcome === "IDLE") break;
          assert.equal(outcome, "ACCEPTED");
          assert.ok(++processed < 300);
        }
        assert.ok(processed > 0);
        const queued = (
          await migration.query(
            "SELECT tenant_id,event_id FROM domain.reservation_email WHERE accepted_at IS NOT NULL ORDER BY created_at LIMIT 1",
          )
        ).rows[0];
        await migration.query(
          "UPDATE domain.reservation_email SET accepted_at=NULL,next_attempt_at=now()-interval '1 second' WHERE tenant_id=$1 AND event_id=$2",
          [queued.tenant_id, queued.event_id],
        );
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const { readdir, readFile } = await import("node:fs/promises");
        const { join } = await import("node:path");
        const mailDir = join(root, "worker-mail");
        const execution = await promisify(execFile)(
          process.execPath,
          ["dist/email-worker.js", "--once"],
          {
            env: {
              ...process.env,
              NODE_ENV: "test",
              WORKER_DATABASE_URL: worker.options.connectionString,
              AUTH_ORIGIN: "https://quenda.test",
              LOCAL_MAIL_DIR: mailDir,
              EMAIL_LOCALE: "gl",
            },
            timeout: 15000,
          },
        );
        assert.match(execution.stdout, /EMAIL_WORKER_READY/);
        assert.match(execution.stdout, /ACCEPTED/);
        assert.match(execution.stdout, /EMAIL_QUEUE_HEALTH/);
        assert.deepEqual(JSON.parse(execution.stderr), {
          event: "EMAIL_QUEUE_ATTENTION",
          exhausted: "2",
        });
        assert.deepEqual(
          (
            await worker.query(
              "SELECT * FROM domain.reservation_email_health()",
            )
          ).rows[0],
          { pending: "0", leased: "0", exhausted: "2" },
        );
        assert.ok(!execution.stderr.includes("@example.test"));
        assert.ok(!execution.stdout.includes("@example.test"));
        const files = await readdir(mailDir);
        assert.equal(files.length, 1);
        const message = JSON.parse(
          await readFile(join(mailDir, files[0] as string), "utf8"),
        );
        assert.match(message.text, /Data do evento/);
        assert.match(message.to, /@example.test$/);
        await migration.query(
          "UPDATE domain.reservation_email SET accepted_at=NULL,next_attempt_at=now()-interval '1 second' WHERE tenant_id=$1 AND event_id=$2",
          [queued.tenant_id, queued.event_id],
        );
        await migration.query(`CREATE FUNCTION domain.test_lost_email_ack() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.outcome='ACCEPTED' THEN RAISE EXCEPTION 'Synthetic lost acknowledgement'; END IF; RETURN NEW; END $$;
          CREATE TRIGGER test_lost_email_ack BEFORE UPDATE ON domain.reservation_email_attempt FOR EACH ROW EXECUTE FUNCTION domain.test_lost_email_ack()`);
        const deliveries: string[] = [];
        const acceptedTransport = {
          send: async (mail: { text: string }) => {
            deliveries.push(mail.text);
          },
        };
        const recoveryOptions = { ...workerOptions, maxAttempts: 10 };
        try {
          await assert.rejects(
            processReservationEmail(worker, acceptedTransport, recoveryOptions),
            { code: "P0001" },
          );
          assert.equal(deliveries.length, 1);
          const unacknowledged = (
            await migration.query(
              "SELECT accepted_at,lease_token FROM domain.reservation_email WHERE tenant_id=$1 AND event_id=$2",
              [queued.tenant_id, queued.event_id],
            )
          ).rows[0];
          assert.equal(unacknowledged.accepted_at, null);
          assert.ok(unacknowledged.lease_token);
          await migration.query(
            "UPDATE domain.reservation_email SET lease_until=now()-interval '1 second' WHERE tenant_id=$1 AND event_id=$2",
            [queued.tenant_id, queued.event_id],
          );
        } finally {
          await migration.query(
            "DROP TRIGGER test_lost_email_ack ON domain.reservation_email_attempt; DROP FUNCTION domain.test_lost_email_ack()",
          );
        }
        assert.equal(
          await processReservationEmail(
            worker,
            acceptedTransport,
            recoveryOptions,
          ),
          "ACCEPTED",
        );
        assert.equal(deliveries.length, 2);
        assert.equal(deliveries[0], deliveries[1]);
        assert.deepEqual(
          (
            await migration.query(
              "SELECT outcome FROM domain.reservation_email_attempt WHERE tenant_id=$1 AND event_id=$2 ORDER BY attempt DESC LIMIT 2",
              [queued.tenant_id, queued.event_id],
            )
          ).rows.map((r) => r.outcome),
          ["ACCEPTED", "EXPIRED"],
        );
        const { spawn } = await import("node:child_process");
        for (const signal of ["SIGINT", "SIGTERM"] as const) {
          const child = spawn(process.execPath, ["dist/email-worker.js"], {
            env: {
              ...process.env,
              NODE_ENV: "test",
              WORKER_DATABASE_URL: worker.options.connectionString,
              AUTH_ORIGIN: "https://quenda.test",
              LOCAL_MAIL_DIR: mailDir,
              EMAIL_LOCALE: "es",
              EMAIL_POLL_MS: "60000",
            },
            stdio: ["ignore", "pipe", "pipe"],
          });
          let output = "",
            errorOutput = "",
            sent = false;
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              child.kill("SIGKILL");
              reject(new Error("Worker shutdown timed out"));
            }, 15000);
            child.once("error", (error) => {
              clearTimeout(timer);
              reject(error);
            });
            child.stdout.on("data", (chunk) => {
              output += chunk.toString();
              if (!sent && output.includes("EMAIL_WORKER_READY")) {
                sent = true;
                child.kill(signal);
              }
            });
            child.stderr.on("data", (chunk) => {
              errorOutput += chunk.toString();
            });
            child.once("close", (code, termination) => {
              clearTimeout(timer);
              try {
                assert.ok(sent);
                assert.equal(code, 0);
                assert.equal(termination, null);
                if (errorOutput)
                  assert.match(errorOutput, /EMAIL_QUEUE_ATTENTION/);
                resolve();
              } catch (error) {
                reject(error);
              }
            });
          });
          assert.equal(
            (
              await migration.query(
                "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name='quenda-email-worker'",
              )
            ).rows[0].n,
            0,
          );
        }

        assert.equal(
          (
            await migration.query(
              "SELECT count(*)::int AS n FROM domain.reservation_email WHERE accepted_at IS NULL AND exhausted_at IS NULL",
            )
          ).rows[0].n,
          0,
        );
      },
    );
  });
});
