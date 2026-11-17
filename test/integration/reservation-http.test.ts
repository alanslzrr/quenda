import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { buildApp } from "../../src/app.ts";
import { commandFingerprint } from "../../src/database/idempotency.ts";
import { transaction } from "../../src/database/transaction.ts";
import { processReservationEmail } from "../../src/modules/communications/index.ts";
import { exportReservations } from "../../src/modules/communications/reservation-export.ts";
import { createAuthentication } from "../../src/modules/identity/index.ts";
import type { MailMessage } from "../../src/shared/mail.ts";
import { browser, totp } from "../helpers/auth-client.ts";
import { withDatabase } from "../helpers/postgres.ts";
import { verifyProductResponses } from "../helpers/response-contract.ts";
import {
  initialAcceptance,
  seedUsageRules,
} from "../helpers/usage-rules-fixture.ts";

test("reservation HTTP uses verified sessions, origin checks and replay across replicas", {
  timeout: 60000,
}, async () => {
  await withDatabase(async ({ domain, auth, migration, worker }) => {
    const messages: MailMessage[] = [];
    const mail = {
      send: async (message: MailMessage) => {
        messages.push(message);
      },
    };
    const config = {
      origin: "https://quenda.test",
      secret: randomBytes(32).toString("hex"),
    };
    const make = () =>
      buildApp({
        database: { check: async () => {}, close: async () => {} },
        domain,
        logLevel: "silent",
        idempotencyRetentionSeconds: 3600,
        identity: {
          authentication: createAuthentication(auth, config, mail),
          config,
        },
      });
    const app = await make(),
      replica = await make();
    const contracts = [app, replica].map(verifyProductResponses);
    try {
      const client = browser(app, "192.0.2.150");
      const password = "Synthetic-password-1234!";
      const signup = await client.request("/api/auth/sign-up/email", {
        name: "Citizen",
        email: "booking@example.test",
        password,
      });
      assert.equal(signup.statusCode, 200, signup.body);
      const accountId = signup.json().user.id;
      const tenant = randomUUID(),
        facility = randomUUID(),
        unit = randomUUID();
      await migration.query(
        "INSERT INTO domain.municipality(id,name,timezone,cancellation_minutes) VALUES($1,'Synthetic','Europe/Madrid',0)",
        [tenant],
      );
      await migration.query(
        "INSERT INTO domain.facility(tenant_id,id,name,published_at) VALUES($1,$2,'Facility',now())",
        [tenant, facility],
      );
      await migration.query(
        "INSERT INTO domain.reservable_unit(tenant_id,id,facility_id,name) VALUES($1,$2,$3,'Unit')",
        [tenant, unit, facility],
      );
      await migration.query(
        `INSERT INTO domain.unit_calendar_version(tenant_id,unit_id,version,minimum_minutes,maximum_minutes,step_minutes,weekly,exceptions,actor_id,reason)
    VALUES($1,$2,1,30,120,30,$3,'[]',$4,'Fixture')`,
        [
          tenant,
          unit,
          JSON.stringify(
            Array.from({ length: 7 }, (_, i) => ({
              day: i + 1,
              startMinute: 0,
              endMinute: 1440,
            })),
          ),
          accountId,
        ],
      );
      await seedUsageRules(migration, tenant, unit, accountId);
      await migration.query(
        "UPDATE domain.reservable_unit SET calendar_version=1,published_at=now() WHERE tenant_id=$1 AND id=$2",
        [tenant, unit],
      );
      const start = new Date();
      start.setUTCDate(start.getUTCDate() + 1);
      start.setUTCHours(10, 0, 0, 0);
      const body = {
        acceptance: initialAcceptance,
        unitId: unit,
        startsAt: start.toISOString(),
        endsAt: new Date(start.getTime() + 3600000).toISOString(),
      };
      const url = `/api/municipalities/${tenant}/reservations`;
      const headers = { "idempotency-key": "http-create" };
      assert.equal((await client.request(url, body, headers)).statusCode, 401);
      const verifyMessage = messages.find((m) =>
        m.text.includes("verify-email"),
      );
      assert.ok(verifyMessage);
      const verify = new URL(
        verifyMessage.text.trim().split("\n").at(-1) ?? "",
      );
      assert.ok(
        [200, 302].includes(
          (await client.request(`${verify.pathname}${verify.search}`))
            .statusCode,
        ),
      );
      const signed = await client.request("/api/auth/sign-in/email", {
        email: "booking@example.test",
        password,
      });
      assert.equal(signed.statusCode, 200, signed.body);
      assert.equal((await client.request(url, body)).statusCode, 400);
      assert.equal(
        (
          await client.request(
            url,
            { ...body, accountId: "someone-else" },
            headers,
          )
        ).statusCode,
        400,
      );
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
          await client.request(url, body, {
            ...headers,
            "sec-fetch-site": "cross-site",
          })
        ).statusCode,
        403,
      );
      const availabilityUrl = `/api/public/municipalities/${tenant}/units/${unit}/availability?date=${body.startsAt.slice(0, 10)}&durationMinutes=60`;
      const available = async () => {
        const response = await app.inject({ url: availabilityUrl });
        assert.equal(response.statusCode, 200, response.body);
        return response
          .json()
          .slots.map(
            (s: { start: { utc: string } }) => s.start.utc,
          ) as string[];
      };
      assert.ok((await available()).includes(body.startsAt));
      const preference = (payload: unknown) =>
        app.inject({
          method: "PUT",
          url: "/api/me/preferences",
          payload: payload as Record<string, unknown>,
          headers: { origin: config.origin, cookie: client.cookie() },
        });
      assert.deepEqual((await client.request("/api/me/preferences")).json(), {
        locale: null,
      });
      assert.equal((await preference({ locale: "fr" })).statusCode, 400);
      assert.equal(
        (await preference({ locale: "es", accountId: "other" })).statusCode,
        400,
      );
      assert.equal(
        (
          await app.inject({
            method: "PUT",
            url: "/api/me/preferences",
            payload: { locale: "es" },
            headers: { cookie: client.cookie() },
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (await app.inject({ url: "/api/me/preferences" })).statusCode,
        401,
      );
      assert.equal((await preference({ locale: "es" })).statusCode, 200);
      assert.deepEqual((await client.request("/api/me/preferences")).json(), {
        locale: "es",
      });
      assert.equal(
        (await domain.query("SELECT * FROM domain.account_preferences"))
          .rowCount,
        0,
      );
      await auth.query(
        "INSERT INTO auth.\"user\"(id,name,email,\"emailVerified\") VALUES('different-account','Different','different@example.test',true)",
      );
      await assert.rejects(
        transaction(
          domain,
          (c) =>
            c.query(
              "INSERT INTO domain.account_preferences(account_id,locale) VALUES($1,'gl')",
              [accountId],
            ),
          { accountId: "different-account", tenantId: null },
        ),
        { code: "42501" },
      );
      const created = await client.request(url, body, headers);
      assert.equal(created.statusCode, 201, created.body);
      assert.ok(!(await available()).includes(body.startsAt));
      assert.equal(created.headers["idempotency-replayed"], "false");
      assert.equal(created.headers["idempotency-retention-seconds"], "3600");
      const expires = new Date(
        String(created.headers["idempotency-expires-at"]),
      ).getTime();
      assert.ok(expires > Date.now() + 3500000);
      const replay = await replica.inject({
        method: "POST",
        url,
        payload: body,
        headers: { ...headers, origin: config.origin, cookie: client.cookie() },
      });
      assert.equal(replay.statusCode, 201, replay.body);
      assert.deepEqual(replay.json(), created.json());
      assert.equal(replay.headers["idempotency-replayed"], "true");
      assert.equal(
        replay.headers["idempotency-expires-at"],
        created.headers["idempotency-expires-at"],
      );
      const changed = await client.request(
        url,
        { ...body, endsAt: new Date(start.getTime() + 7200000).toISOString() },
        headers,
      );
      assert.equal(changed.statusCode, 409, changed.body);
      const occupied = await client.request(url, body, {
        "idempotency-key": "other-command",
      });
      assert.equal(occupied.statusCode, 409, occupied.body);
      for (const table of [
        "reservation",
        "reservation_event",
        "reservation_notice",
        "reservation_email",
        "idempotent_command",
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
      const schema = app.swagger();
      const operation =
        schema.paths?.["/api/municipalities/{tenantId}/reservations"]?.post;
      assert.ok(operation);
      assert.match(operation.description ?? "", /3600 segundos/);
      assert.ok(
        JSON.stringify(operation.responses?.["201"]).includes(
          "idempotency-expires-at",
        ),
      );
      assert.equal((await preference({ locale: "gl" })).statusCode, 200);
      const modifyUrl = `${url}/${created.json().id}/modify`;
      const changedBody = {
        unitId: unit,
        startsAt: new Date(start.getTime() + 7200000).toISOString(),
        endsAt: new Date(start.getTime() + 10800000).toISOString(),
        expectedRevision: 1,
      };
      const modified = await client.request(modifyUrl, changedBody, {
        "idempotency-key": "http-modify",
      });
      assert.equal(modified.statusCode, 200, modified.body);
      assert.equal(modified.json().revision, 2);
      assert.ok((await available()).includes(body.startsAt));
      assert.ok(!(await available()).includes(changedBody.startsAt));
      const modifiedReplay = await replica.inject({
        method: "POST",
        url: modifyUrl,
        payload: changedBody,
        headers: {
          origin: config.origin,
          cookie: client.cookie(),
          "idempotency-key": "http-modify",
        },
      });
      assert.equal(modifiedReplay.statusCode, 200, modifiedReplay.body);
      assert.deepEqual(modifiedReplay.json(), modified.json());
      assert.equal(modifiedReplay.headers["idempotency-replayed"], "true");
      const cancelUrl = `${url}/${created.json().id}/cancel`;
      const cancelled = await client.request(
        cancelUrl,
        { expectedRevision: 2 },
        { "idempotency-key": "http-cancel" },
      );
      assert.equal(cancelled.statusCode, 200, cancelled.body);
      assert.equal(cancelled.json().status, "CANCELADA");
      assert.equal(cancelled.json().revision, 3);
      const detail = await client.request(`${url}/${created.json().id}`);
      assert.equal(detail.statusCode, 200, detail.body);
      assert.equal(detail.json().status, "CANCELADA");
      assert.equal(detail.json().revision, 3);
      assert.equal(detail.json().usageRulesVersion, 1);
      assert.equal(detail.json().usageRulesText, "Synthetic fixture rules");
      assert.equal(detail.json().unitName, "Unit");
      assert.equal(detail.json().facilityName, "Facility");
      assert.equal(detail.json().municipalityName, "Synthetic");
      assert.ok(detail.json().rulesAcceptedAt);
      assert.ok(detail.json().conditionsAcceptedAt);
      const snapshots = (
        await migration.query(
          "SELECT e.revision,q.locale FROM domain.reservation_email q JOIN domain.reservation_event e ON (e.tenant_id,e.id)=(q.tenant_id,q.event_id) WHERE e.reservation_id=$1 ORDER BY e.revision",
          [created.json().id],
        )
      ).rows;
      assert.deepEqual(snapshots, [
        { revision: 1, locale: "es" },
        { revision: 2, locale: "gl" },
        { revision: 3, locale: "gl" },
      ]);
      assert.equal((await preference({ locale: null })).statusCode, 200);
      const delivered: string[] = [];
      for (let i = 0; i < 3; i++)
        assert.equal(
          await processReservationEmail(
            worker,
            {
              send: async (mail) => {
                delivered.push(mail.text);
              },
            },
            {
              origin: config.origin,
              locale: "es",
              leaseSeconds: 30,
              maxAttempts: 3,
              retrySeconds: 60,
            },
          ),
          "ACCEPTED",
        );
      assert.match(delivered[0] as string, /Fecha del evento/);
      assert.match(delivered[1] as string, /Data do evento/);
      assert.match(delivered[2] as string, /Data do evento/);

      const notices = await client.request("/api/me/notices");
      assert.equal(notices.statusCode, 200, notices.body);
      assert.equal(notices.headers["cache-control"], "no-store");
      const events = notices
        .json()
        .items.filter(
          (n: { reservationId: string }) =>
            n.reservationId === created.json().id,
        )
        .sort(
          (a: { revision: number }, b: { revision: number }) =>
            a.revision - b.revision,
        );
      assert.deepEqual(
        events.map((n: { kind: string }) => n.kind),
        ["CONFIRMADA", "MODIFICADA", "CANCELADA"],
      );
      assert.equal(events[0].startsAt, body.startsAt);
      assert.equal(events[2].reservationPath, `${url}/${created.json().id}`);
      // Newest first, naming where the reservation is; new notices start unread.
      const listed = notices.json().items as {
        tenantId: string;
        eventId: string;
        occurredAt: string;
        readAt: string | null;
      }[];
      for (let i = 1; i < listed.length; i++)
        assert.ok(
          Date.parse(listed[i - 1]?.occurredAt ?? "") >=
            Date.parse(listed[i]?.occurredAt ?? ""),
        );
      assert.ok(
        events.every(
          (n: {
            municipality: string;
            unitName: string | null;
            facilityName: string | null;
            readAt: string | null;
          }) =>
            n.municipality.length > 0 &&
            !!n.unitName &&
            !!n.facilityName &&
            n.readAt === null,
        ),
      );
      const unreadInDatabase = async () =>
        (
          await migration.query(
            "SELECT count(*)::int AS n FROM domain.reservation_notice WHERE account_id=$1 AND read_at IS NULL",
            [accountId],
          )
        ).rows[0].n as number;
      const counted = await client.request("/api/me/notices/unread");
      assert.equal(counted.statusCode, 200, counted.body);
      assert.equal(counted.headers["cache-control"], "no-store");
      const before = counted.json().unread as number;
      assert.ok(before >= 3);
      assert.equal(before, await unreadInDatabase());
      const readOne = await client.request(
        `/api/me/notices/${events[0].tenantId}/${events[0].eventId}/read`,
        {},
      );
      assert.equal(readOne.statusCode, 200, readOne.body);
      assert.deepEqual(readOne.json(), { read: 1 });
      assert.equal(await unreadInDatabase(), before - 1);
      assert.deepEqual(
        (await client.request("/api/me/notices/read", {})).json(),
        { read: before - 1 },
      );
      assert.equal(await unreadInDatabase(), 0);
      // Start a fresh rate-limit window, so these checks never push the rest of the journey over the limit.
      await migration.query(
        "UPDATE domain.administrative_rate_limit SET window_started_at=now()-interval '1 minute' WHERE account_id=$1",
        [accountId],
      );
      assert.equal(
        (await app.inject({ url: "/api/me/notices/unread" })).statusCode,
        401,
      );
      assert.equal(
        (
          await client.request(
            "/api/me/notices/not-a-tenant/not-an-event/read",
            {},
          )
        ).statusCode,
        400,
      );
      assert.equal(
        (await app.inject({ url: "/api/me/notices" })).statusCode,
        401,
      );
      assert.equal(
        (await client.request("/api/me/notices?after=invalid")).statusCode,
        400,
      );
      assert.equal(
        (await client.request("/api/me/notices?accountId=other")).statusCode,
        400,
      );
      assert.ok(
        (app.swagger() as { paths: Record<string, unknown> }).paths[
          "/api/me/notices"
        ],
      );

      assert.equal(detail.headers["cache-control"], "no-store");
      const originalReplay = await client.request(url, body, headers);
      assert.equal(originalReplay.statusCode, 201, originalReplay.body);
      assert.equal(originalReplay.json().status, "CONFIRMADA");
      assert.equal(originalReplay.json().revision, 1);
      assert.equal(
        (await app.inject({ url: `${url}/${created.json().id}` })).statusCode,
        401,
      );
      assert.ok((await available()).includes(changedBody.startsAt));
      const cancelReplay = await replica.inject({
        method: "POST",
        url: cancelUrl,
        payload: { expectedRevision: 2 },
        headers: {
          origin: config.origin,
          cookie: client.cookie(),
          "idempotency-key": "http-cancel",
        },
      });
      assert.equal(cancelReplay.statusCode, 200, cancelReplay.body);
      assert.deepEqual(cancelReplay.json(), cancelled.json());
      assert.equal(cancelReplay.headers["idempotency-replayed"], "true");
      // An upgrade can retain a completed pre-acceptance cancellation result.
      // Its missing evidence must not cause serialization failure or be filled
      // from the newer reservation state, which has genuine acceptance here.
      const reservationBeforeLegacyReplay = (
        await migration.query(
          "SELECT * FROM domain.reservation WHERE tenant_id=$1 AND id=$2",
          [tenant, created.json().id],
        )
      ).rows;
      assert.equal(reservationBeforeLegacyReplay[0].usage_rules_version, 1);
      assert.ok(reservationBeforeLegacyReplay[0].rules_accepted_at);
      const eventsBeforeLegacyReplay = (
        await migration.query(
          "SELECT * FROM domain.reservation_event WHERE tenant_id=$1 AND reservation_id=$2 ORDER BY revision",
          [tenant, created.json().id],
        )
      ).rows;
      const oldEvidence = {
        usageRulesUnitId: null,
        usageRulesVersion: null,
        rulesAcceptedAt: null,
        bookingPolicyVersion: null,
        conditionsAcceptedAt: null,
        nonCancellableAccepted: null,
        pendingUsageRulesVersion: null,
      };
      const legacyCommand = (
        await migration.query(
          "UPDATE domain.idempotent_command SET result=result-$3::text[] WHERE tenant_id=$1 AND actor_id=$2 AND operation='reservation.cancel' AND key='http-cancel' RETURNING *",
          [tenant, accountId, Object.keys(oldEvidence)],
        )
      ).rows;
      assert.equal(legacyCommand.length, 1);
      assert.equal(
        Object.hasOwn(legacyCommand[0].result, "usageRulesVersion"),
        false,
      );
      const legacyReplay = await replica.inject({
        method: "POST",
        url: cancelUrl,
        payload: { expectedRevision: 2 },
        headers: {
          origin: config.origin,
          cookie: client.cookie(),
          "idempotency-key": "http-cancel",
        },
      });
      assert.equal(legacyReplay.statusCode, 200, legacyReplay.body);
      assert.equal(legacyReplay.headers["idempotency-replayed"], "true");
      assert.deepEqual(legacyReplay.json(), {
        ...cancelled.json(),
        ...oldEvidence,
      });
      assert.deepEqual(
        (
          await migration.query(
            "SELECT * FROM domain.reservation WHERE tenant_id=$1 AND id=$2",
            [tenant, created.json().id],
          )
        ).rows,
        reservationBeforeLegacyReplay,
      );
      assert.deepEqual(
        (
          await migration.query(
            "SELECT * FROM domain.reservation_event WHERE tenant_id=$1 AND reservation_id=$2 ORDER BY revision",
            [tenant, created.json().id],
          )
        ).rows,
        eventsBeforeLegacyReplay,
      );
      assert.deepEqual(
        (
          await migration.query(
            "SELECT * FROM domain.idempotent_command WHERE tenant_id=$1 AND actor_id=$2 AND operation='reservation.cancel' AND key='http-cancel'",
            [tenant, accountId],
          )
        ).rows,
        legacyCommand,
      );
      const legacyCreateBody = {
        unitId: body.unitId,
        startsAt: body.startsAt,
        endsAt: body.endsAt,
      };
      // Legacy create/modify commands omitted acceptance entirely; adding
      // acceptance:null to their fingerprint would reject a genuine replay.
      for (const entry of [
        {
          operation: "reservation.create",
          key: "http-create",
          url,
          body: legacyCreateBody,
          fingerprintInput: legacyCreateBody,
          status: 201,
          original: created.json(),
        },
        {
          operation: "reservation.modify",
          key: "http-modify",
          url: modifyUrl,
          body: changedBody,
          fingerprintInput: {
            ...changedBody,
            reservationId: created.json().id,
            administrative: false,
            reason: null,
          },
          status: 200,
          original: modified.json(),
        },
      ]) {
        const retained = (
          await migration.query(
            "UPDATE domain.idempotent_command SET fingerprint=$5,result=result-$6::text[] WHERE tenant_id=$1 AND actor_id=$2 AND operation=$3 AND key=$4 RETURNING *",
            [
              tenant,
              accountId,
              entry.operation,
              entry.key,
              commandFingerprint(entry.fingerprintInput),
              Object.keys(oldEvidence),
            ],
          )
        ).rows;
        assert.equal(retained.length, 1);
        const oldReplay = await replica.inject({
          method: "POST",
          url: entry.url,
          payload: entry.body,
          headers: {
            origin: config.origin,
            cookie: client.cookie(),
            "idempotency-key": entry.key,
          },
        });
        assert.equal(oldReplay.statusCode, entry.status, oldReplay.body);
        assert.equal(oldReplay.headers["idempotency-replayed"], "true");
        assert.equal(
          oldReplay.headers["idempotency-expires-at"],
          retained[0].expires_at.toISOString(),
        );
        assert.deepEqual(oldReplay.json(), {
          ...entry.original,
          ...oldEvidence,
        });
        // An explicit acceptance is different input, never an alias for the
        // legacy command's absent evidence.
        const changedAcceptance = await client.request(
          entry.url,
          { ...entry.body, acceptance: initialAcceptance },
          { "idempotency-key": entry.key },
        );
        assert.equal(changedAcceptance.statusCode, 409, changedAcceptance.body);
        assert.deepEqual(
          (
            await migration.query(
              "SELECT * FROM domain.idempotent_command WHERE tenant_id=$1 AND actor_id=$2 AND operation=$3 AND key=$4",
              [tenant, accountId, entry.operation, entry.key],
            )
          ).rows,
          retained,
        );
      }
      const newWithoutAcceptance = await client.request(url, legacyCreateBody, {
        "idempotency-key": "fresh-without-acceptance",
      });
      assert.equal(
        newWithoutAcceptance.statusCode,
        409,
        newWithoutAcceptance.body,
      );
      assert.equal(
        newWithoutAcceptance.json().error.code,
        "CONDITIONS_ACCEPTANCE_REQUIRED",
      );
      assert.equal(
        (
          await migration.query(
            "SELECT 1 FROM domain.idempotent_command WHERE tenant_id=$1 AND actor_id=$2 AND key='fresh-without-acceptance'",
            [tenant, accountId],
          )
        ).rowCount,
        0,
      );
      assert.deepEqual(
        (
          await migration.query(
            "SELECT * FROM domain.reservation WHERE tenant_id=$1 AND id=$2",
            [tenant, created.json().id],
          )
        ).rows,
        reservationBeforeLegacyReplay,
      );
      assert.equal(
        (
          await migration.query(
            "SELECT count(*)::int AS n FROM domain.reservation",
          )
        ).rows[0].n,
        1,
      );
      assert.deepEqual(
        (
          await migration.query(
            "SELECT * FROM domain.reservation_event WHERE tenant_id=$1 AND reservation_id=$2 ORDER BY revision",
            [tenant, created.json().id],
          )
        ).rows,
        eventsBeforeLegacyReplay,
      );
      assert.equal(
        (
          await migration.query(
            "SELECT count(*)::int AS n FROM domain.occupancy WHERE released_at IS NULL",
          )
        ).rows[0].n,
        0,
      );
      const second = await client.request(url, body, {
        "idempotency-key": "after-cancel",
      });
      assert.equal(second.statusCode, 201, second.body);
      const own = await client.request("/api/me/reservations");
      assert.equal(own.statusCode, 200, own.body);
      assert.equal(own.headers["cache-control"], "no-store");
      assert.ok(
        own
          .json()
          .items.some((r: { id: string }) => r.id === created.json().id),
      );
      assert.equal(
        (await app.inject({ url: "/api/me/reservations" })).statusCode,
        401,
      );
      assert.equal(
        (await client.request("/api/me/reservations?accountId=other"))
          .statusCode,
        400,
      );
      assert.equal((await client.request(url)).statusCode, 403);
      const blockUrl = `/api/municipalities/${tenant}/blocks`;
      const blockBody = {
        unitId: unit,
        startsAt: new Date(start.getTime() + 14400000).toISOString(),
        endsAt: new Date(start.getTime() + 18000000).toISOString(),
        reason: "Maintenance",
      };
      assert.equal(
        (
          await client.request(blockUrl, blockBody, {
            "idempotency-key": "http-block",
          })
        ).statusCode,
        403,
      );
      const enrolled = await client.request("/api/auth/two-factor/enable", {
        password,
      });
      assert.equal(enrolled.statusCode, 200, enrolled.body);
      const secret = new URL(enrolled.json().totpURI).searchParams.get(
        "secret",
      );
      assert.ok(secret);
      const verified = await client.request(
        "/api/auth/two-factor/verify-totp",
        { code: totp(secret) },
      );
      assert.equal(verified.statusCode, 200, verified.body);
      const invitation = randomUUID();
      await migration.query(
        "INSERT INTO domain.administrator_invitation(tenant_id,id,account_id,invited_by,expires_at,accepted_at) VALUES($1,$2,$3,$3,now()+interval '1 day',now())",
        [tenant, invitation, accountId],
      );
      await migration.query(
        "INSERT INTO domain.municipal_administrator(tenant_id,account_id,invitation_id) VALUES($1,$2,$3)",
        [tenant, accountId, invitation],
      );
      const managed = await client.request(url);
      assert.equal(managed.statusCode, 200, managed.body);
      assert.ok(
        managed
          .json()
          .items.every((r: { accountId: string }) => r.accountId === accountId),
      );
      const blocked = await client.request(blockUrl, blockBody, {
        "idempotency-key": "http-block",
      });
      assert.equal(blocked.statusCode, 201, blocked.body);
      assert.ok(!(await available()).includes(blockBody.startsAt));
      const blockReplay = await replica.inject({
        method: "POST",
        url: blockUrl,
        payload: blockBody,
        headers: {
          origin: config.origin,
          cookie: client.cookie(),
          "idempotency-key": "http-block",
        },
      });
      assert.equal(blockReplay.statusCode, 201, blockReplay.body);
      assert.deepEqual(blockReplay.json(), blocked.json());
      const released = await client.request(
        `${blockUrl}/${blocked.json().id}/release`,
        { reason: "Completed" },
        { "idempotency-key": "http-release" },
      );
      assert.equal(released.statusCode, 200, released.body);
      assert.ok(released.json().releasedAt);
      assert.ok((await available()).includes(blockBody.startsAt));
      const calendarUrl = `/api/municipalities/${tenant}/units/${unit}/calendar`;
      const closure = {
        expectedVersion: 1,
        reason: "Closure",
        calendar: {
          minimumMinutes: 30,
          maximumMinutes: 120,
          stepMinutes: 30,
          advanceDays: null,
          weekly: Array.from({ length: 7 }, (_, i) => ({
            day: i + 1,
            startMinute: 0,
            endMinute: 1440,
          })),
          exceptions: [{ date: body.startsAt.slice(0, 10), intervals: [] }],
        },
      };
      const closeCalendar = () =>
        app.inject({
          method: "PUT",
          url: calendarUrl,
          payload: closure,
          headers: { origin: config.origin, cookie: client.cookie() },
        });
      const incompatible = await closeCalendar();
      assert.equal(incompatible.statusCode, 409, incompatible.body);
      const resolved = await client.request(
        `${url}/${second.json().id}/cancel`,
        { expectedRevision: 1 },
        { "idempotency-key": "resolve-closure" },
      );
      assert.equal(resolved.statusCode, 200, resolved.body);
      const compatible = await closeCalendar();
      assert.equal(compatible.statusCode, 200, compatible.body);
      assert.equal(compatible.json().version, 2);
      assert.deepEqual(await available(), []);
      const indicatorUrl = `/api/municipalities/${tenant}/units/${unit}/indicators?from=2030-01-01&to=2030-01-02`;
      const unavailableReport = await client.request(indicatorUrl);
      assert.equal(unavailableReport.statusCode, 200, unavailableReport.body);
      assert.equal(unavailableReport.json().occupancyPercent, null);
      for (const [operation, eventUnit, occurred] of [
        ["PUBLISH_FACILITY", null, "2029-12-31T23:00:00Z"],
        ["PUBLISH_UNIT", unit, "2029-12-31T23:00:00Z"],
        ["WITHDRAW_FACILITY", null, "2030-01-01T11:00:00Z"],
      ] as const)
        await migration.query(
          "INSERT INTO domain.catalog_event(tenant_id,id,actor_id,facility_id,unit_id,operation,occurred_at,reason,calendar_version,independence_confirmed) VALUES($1,$2,$3,$4,$5,$6,$7,'Historical fixture',CASE WHEN $5::uuid IS NULL THEN NULL ELSE 1 END,true)",
          [
            tenant,
            randomUUID(),
            accountId,
            facility,
            eventUnit,
            operation,
            occurred,
          ],
        );
      await migration.query(
        "INSERT INTO domain.schedule_block(tenant_id,id,unit_id,starts_at,ends_at,actor_id,reason,created_at,released_at) VALUES($1,$2,$3,'2030-01-01T08:00:00Z','2030-01-01T10:00:00Z',$4,'Historical fixture','2030-01-01T07:00:00Z','2030-01-01T09:00:00Z')",
        [tenant, randomUUID(), unit, accountId],
      );
      const report = await client.request(indicatorUrl);
      assert.equal(report.statusCode, 200, report.body);
      assert.equal(report.headers["cache-control"], "no-store");
      assert.equal(report.json().offeredMinutes, 660);
      await migration.query(
        "INSERT INTO domain.unit_calendar_version(tenant_id,unit_id,version,minimum_minutes,maximum_minutes,step_minutes,advance_days,weekly,exceptions,actor_id,reason,created_at) SELECT tenant_id,unit_id,n,minimum_minutes,maximum_minutes,step_minutes,advance_days,weekly,exceptions,actor_id,'Older history',timestamptz '2028-01-01T00:00:00Z'+n*interval '1 minute' FROM domain.unit_calendar_version CROSS JOIN generate_series(3,1004) n WHERE tenant_id=$1 AND unit_id=$2 AND version=1",
        [tenant, unit],
      );
      await migration.query(
        "INSERT INTO domain.catalog_event(tenant_id,id,actor_id,facility_id,unit_id,operation,occurred_at,reason,calendar_version,independence_confirmed) SELECT $1,gen_random_uuid(),$2,$3,$4,CASE WHEN n%2=0 THEN 'PUBLISH_UNIT' ELSE 'WITHDRAW_UNIT' END,timestamptz '2028-01-01T00:00:00Z'+n*interval '1 minute','Older history',1,true FROM generate_series(1,2002) n",
        [tenant, accountId, facility, unit],
      );
      const retainedHistory = await client.request(indicatorUrl);
      assert.equal(retainedHistory.statusCode, 200, retainedHistory.body);
      assert.equal(retainedHistory.json().offeredMinutes, 660);
      const projectionSize = await transaction(
        domain,
        async (c) =>
          (
            await c.query(
              "SELECT jsonb_array_length(source->'calendars') AS calendars,jsonb_array_length(source->'publications') AS publications FROM (SELECT domain.unit_indicator_source($1,'2030-01-01','2030-01-02') AS source) q",
              [unit],
            )
          ).rows[0],
        { accountId, tenantId: tenant },
      );
      assert.deepEqual(projectionSize, { calendars: 1, publications: 4 });

      assert.equal(report.json().reservedMinutes, 0);
      assert.equal(report.json().occupancyPercent, 0);
      assert.ok(!report.body.includes("accountId"));
      assert.equal((await app.inject({ url: indicatorUrl })).statusCode, 401);
      assert.equal(
        (await client.request(indicatorUrl.replace(unit, randomUUID())))
          .statusCode,
        404,
      );
      assert.equal(
        (await client.request(indicatorUrl.replace(tenant, randomUUID())))
          .statusCode,
        403,
      );
      assert.equal(
        (
          await client.request(
            indicatorUrl.replace("to=2030-01-02", "to=2032-01-01"),
          )
        ).statusCode,
        400,
      );
      assert.ok(
        (app.swagger() as { paths: Record<string, unknown> }).paths[
          "/api/municipalities/{tenantId}/units/{unitId}/indicators"
        ],
      );
      await assert.rejects(
        domain.query(
          "SELECT domain.unit_indicator_source($1,'2030-01-01','2030-01-02')",
          [unit],
        ),
        { code: "42501" },
      );

      const municipalUrl = `/api/municipalities/${tenant}/indicators?from=2030-01-01&to=2030-01-02`;
      const otherUnit = randomUUID();
      await migration.query(
        "INSERT INTO domain.reservable_unit(tenant_id,id,facility_id,name) VALUES($1,$2,$3,'Second historical unit')",
        [tenant, otherUnit, facility],
      );
      await migration.query(
        "INSERT INTO domain.unit_calendar_version(tenant_id,unit_id,version,minimum_minutes,maximum_minutes,step_minutes,weekly,exceptions,actor_id,reason,created_at) SELECT tenant_id,$3,1,minimum_minutes,maximum_minutes,step_minutes,weekly,exceptions,actor_id,'Fixture','2029-12-01T00:00:00Z' FROM domain.unit_calendar_version WHERE tenant_id=$1 AND unit_id=$2 AND version=1",
        [tenant, unit, otherUnit],
      );
      await migration.query(
        "INSERT INTO domain.catalog_event(tenant_id,id,actor_id,facility_id,unit_id,operation,occurred_at,reason,calendar_version,independence_confirmed) VALUES($1,gen_random_uuid(),$2,$3,$4,'PUBLISH_UNIT','2029-12-31T23:00:00Z','Fixture',1,true)",
        [tenant, accountId, facility, otherUnit],
      );
      await migration.query(
        "WITH booking AS (INSERT INTO domain.reservation(tenant_id,id,account_id,unit_id,calendar_version,starts_at,ends_at,cancellation_minutes,timezone) VALUES($1,gen_random_uuid(),$2,$3,1,'2030-01-01T00:00:00Z','2030-01-01T01:00:00Z',60,'Europe/Madrid') RETURNING *) INSERT INTO domain.occupancy(tenant_id,id,unit_id,reservation_id,period) SELECT tenant_id,gen_random_uuid(),unit_id,id,tstzrange(starts_at,ends_at,'[)') FROM booking",
        [tenant, accountId, otherUnit],
      );
      await migration.query(
        "INSERT INTO domain.reservation(tenant_id,id,account_id,unit_id,calendar_version,starts_at,ends_at,status,cancellation_minutes,timezone) VALUES($1,gen_random_uuid(),$2,$3,1,'2030-01-01T02:00:00Z','2030-01-01T03:00:00Z','CANCELADA',60,'Europe/Madrid')",
        [tenant, accountId, otherUnit],
      );
      const total = await client.request(municipalUrl);
      assert.equal(total.statusCode, 200, total.body);
      assert.equal(total.headers["cache-control"], "no-store");
      assert.equal(total.json().offeredMinutes, 1380);
      assert.equal(total.json().reservedMinutes, 60);
      assert.ok(
        Math.abs(total.json().occupancyPercent - (60 / 1380) * 100) < 1e-9,
      );
      assert.deepEqual(total.json().reservations, {
        CONFIRMADA: 1,
        CANCELADA: 1,
        FINALIZADA: 0,
      });
      assert.equal(total.json().unitId, undefined);
      assert.equal((await app.inject({ url: municipalUrl })).statusCode, 401);
      assert.equal(
        (await client.request(municipalUrl.replace(tenant, randomUUID())))
          .statusCode,
        403,
      );
      assert.ok(
        (app.swagger() as { paths: Record<string, unknown> }).paths[
          "/api/municipalities/{tenantId}/indicators"
        ],
      );
      await assert.rejects(
        domain.query(
          "SELECT domain.municipal_indicator_source('2030-01-01','2030-01-02')",
        ),
        { code: "42501" },
      );
      const emptyTenant = randomUUID(),
        emptyInvitation = randomUUID();
      await migration.query(
        "INSERT INTO domain.municipality(id,name,timezone,cancellation_minutes) VALUES($1,'Empty','Europe/Madrid',0)",
        [emptyTenant],
      );
      await migration.query(
        "INSERT INTO domain.municipal_profile(tenant_id,account_id) VALUES($1,$2)",
        [emptyTenant, accountId],
      );
      await migration.query(
        "INSERT INTO domain.administrator_invitation(tenant_id,id,account_id,invited_by,expires_at,accepted_at) VALUES($1,$2,$3,$3,now()+interval '1 day',now())",
        [emptyTenant, emptyInvitation, accountId],
      );
      await migration.query(
        "INSERT INTO domain.municipal_administrator(tenant_id,account_id,invitation_id) VALUES($1,$2,$3)",
        [emptyTenant, accountId, emptyInvitation],
      );
      const empty = await client.request(
        municipalUrl.replace(tenant, emptyTenant),
      );
      assert.equal(empty.statusCode, 200, empty.body);
      assert.equal(empty.json().offeredMinutes, 0);
      assert.equal(empty.json().reservedMinutes, 0);
      assert.equal(empty.json().occupancyPercent, null);
      assert.deepEqual(empty.json().reservations, {
        CONFIRMADA: 0,
        CANCELADA: 0,
        FINALIZADA: 0,
      });
      const exportActor = {
        accountId,
        email: "booking@example.test",
        sessionId: "export-fixture",
        mfaVerifiedAt: new Date(),
      };
      const exportData = JSON.parse(
        JSON.stringify(
          await exportReservations(
            domain,
            exportActor,
            tenant,
            "2030-01-01",
            "2030-01-02",
          ),
        ),
      );
      assert.equal(exportData.format, "quenda.reservations");
      assert.equal(exportData.version, 3);
      assert.equal(exportData.tenantId, tenant);
      assert.equal(exportData.unitId, null);
      assert.deepEqual(exportData.entities, ["reservations"]);
      assert.deepEqual(exportData.period, {
        from: "2030-01-01",
        to: "2030-01-02",
        timeZone: "Europe/Madrid",
        selection: "overlap",
      });
      assert.equal(exportData.reservations.length, 2);
      for (const reservation of exportData.reservations) {
        assert.equal(reservation.usageRulesVersion, null);
        assert.equal(reservation.usageRulesUnitId, null);
        assert.equal(reservation.pendingUsageRulesVersion, null);
        assert.equal(reservation.pendingUsageRulesText, null);
        assert.equal(reservation.usageRulesText, null);
        assert.equal(reservation.rulesAcceptedAt, null);
        assert.equal(reservation.bookingPolicyVersion, null);
        assert.equal(reservation.conditionsAcceptedAt, null);
        assert.equal(reservation.nonCancellableAccepted, null);
      }
      assert.ok(
        exportData.reservations.every(
          (r: { unitId: string; accountId: string }) =>
            r.unitId === otherUnit && r.accountId === accountId,
        ),
      );
      await assert.rejects(
        exportReservations(
          domain,
          { ...exportActor, mfaVerifiedAt: null },
          tenant,
          "2030-01-01",
          "2030-01-02",
        ),
        { code: "FORBIDDEN" },
      );
      await assert.rejects(
        exportReservations(
          domain,
          { ...exportActor, mfaVerifiedAt: new Date(Date.now() - 360000) },
          tenant,
          "2030-01-01",
          "2030-01-02",
        ),
        { code: "REAUTHENTICATION_REQUIRED" },
      );
      await assert.rejects(
        exportReservations(
          domain,
          exportActor,
          tenant,
          "2030-02-30",
          "2030-03-01",
        ),
        { code: "INVALID_INPUT" },
      );
      await assert.rejects(
        domain.query(
          "SELECT domain.reservation_export('2030-01-01','2030-01-02')",
        ),
        { code: "42501" },
      );
      const exportUrl = `/api/municipalities/${tenant}/exports/reservations?from=2030-01-01&to=2030-01-02`;
      const boundaries = [
        ["2029-12-31T22:00:00Z", "2029-12-31T23:00:00Z"],
        ["2029-12-31T22:30:00Z", "2029-12-31T23:30:00Z"],
        ["2030-01-01T22:30:00Z", "2030-01-01T23:30:00Z"],
        ["2030-01-01T23:00:00Z", "2030-01-02T00:00:00Z"],
      ].map(([start, end]) => ({ id: randomUUID(), start, end }));
      for (const b of boundaries)
        await migration.query(
          "INSERT INTO domain.reservation(tenant_id,id,account_id,unit_id,calendar_version,starts_at,ends_at,status,cancellation_minutes,timezone) VALUES($1,$2,$3,$4,1,$5,$6,'CANCELADA',60,'Europe/Madrid')",
          [tenant, b.id, accountId, unit, b.start, b.end],
        );
      const downloaded = await client.request(exportUrl);
      assert.equal(downloaded.statusCode, 200, downloaded.body);
      assert.equal(downloaded.headers["cache-control"], "no-store");
      assert.equal(
        downloaded.headers["content-disposition"],
        'attachment; filename="quenda-reservations-v3.json"',
      );
      assert.equal(downloaded.json().reservations.length, 4);
      const rows = downloaded.json().reservations as Array<{
        id: string;
        startsAt: string;
        endsAt: string;
      }>;
      assert.ok(
        !rows.some(
          (r) => r.id === boundaries[0]?.id || r.id === boundaries[3]?.id,
        ),
      );
      for (const b of boundaries.slice(1, 3)) {
        const r = rows.find((r) => r.id === b.id);
        assert.ok(r);
        assert.equal(Date.parse(r.startsAt), Date.parse(b.start as string));
        assert.equal(Date.parse(r.endsAt), Date.parse(b.end as string));
      }
      const emptyExport = await client.request(
        exportUrl.replace(tenant, emptyTenant),
      );
      assert.equal(emptyExport.statusCode, 200, emptyExport.body);
      assert.equal(emptyExport.json().reservations.length, 0);
      assert.equal(emptyExport.json().tenantId, emptyTenant);
      assert.equal(
        (await client.request(exportUrl.replace(tenant, randomUUID())))
          .statusCode,
        403,
      );
      assert.equal((await app.inject({ url: exportUrl })).statusCode, 401);
      assert.equal(
        (await client.request(`${exportUrl}&unitId=${randomUUID()}`))
          .statusCode,
        404,
      );
      assert.equal(
        (
          await client.request(
            exportUrl.replace("to=2030-01-02", "to=2032-01-02"),
          )
        ).statusCode,
        400,
      );
      assert.ok(
        (app.swagger() as { paths: Record<string, unknown> }).paths[
          "/api/municipalities/{tenantId}/exports/reservations"
        ],
      );
      const managerInvitation = randomUUID();
      await migration.query(
        "INSERT INTO domain.manager_invitation(tenant_id,id,account_id,invited_by,issuer_invitation_id,expires_at,accepted_at) VALUES($1,$2,$3,$3,$4,now()+interval '1 day',now())",
        [tenant, managerInvitation, accountId, invitation],
      );
      await migration.query(
        "INSERT INTO domain.manager_grant(tenant_id,invitation_id,account_id) VALUES($1,$2,$3)",
        [tenant, managerInvitation, accountId],
      );
      await migration.query(
        "INSERT INTO domain.manager_permission(tenant_id,invitation_id,operation,unit_id) VALUES($1,$2,'REPORT_READ',$3)",
        [tenant, managerInvitation, unit],
      );
      await migration.query(
        "UPDATE domain.municipal_administrator SET revoked_at=now() WHERE tenant_id=$1 AND account_id=$2",
        [tenant, accountId],
      );
      assert.equal((await client.request(indicatorUrl)).statusCode, 200);
      assert.equal(
        (await client.request(indicatorUrl.replace(unit, otherUnit)))
          .statusCode,
        403,
      );
      assert.equal((await client.request(municipalUrl)).statusCode, 403);
      await migration.query(
        "INSERT INTO domain.manager_permission(tenant_id,invitation_id,operation,unit_id) VALUES($1,$2,'REPORT_READ',NULL)",
        [tenant, managerInvitation],
      );
      const managerTotal = await client.request(municipalUrl);
      assert.equal(managerTotal.statusCode, 200, managerTotal.body);
      assert.equal(managerTotal.json().offeredMinutes, 1380);
      await migration.query(
        "UPDATE domain.manager_grant SET revoked_at=now() WHERE tenant_id=$1 AND invitation_id=$2",
        [tenant, managerInvitation],
      );
      assert.equal((await client.request(indicatorUrl)).statusCode, 403);
      assert.equal((await client.request(municipalUrl)).statusCode, 403);

      await migration.query(
        "UPDATE domain.manager_grant SET revoked_at=NULL WHERE tenant_id=$1 AND invitation_id=$2",
        [tenant, managerInvitation],
      );
      await migration.query(
        "INSERT INTO domain.manager_permission(tenant_id,invitation_id,operation,unit_id) VALUES($1,$2,'DATA_EXPORT',$3)",
        [tenant, managerInvitation, otherUnit],
      );
      await assert.rejects(
        exportReservations(
          domain,
          exportActor,
          tenant,
          "2030-01-01",
          "2030-01-02",
          otherUnit,
        ),
        { code: "FORBIDDEN" },
      );
      await migration.query(
        "INSERT INTO domain.manager_permission(tenant_id,invitation_id,operation,unit_id) VALUES($1,$2,'RESERVATION_READ',$3)",
        [tenant, managerInvitation, otherUnit],
      );
      assert.equal(
        JSON.parse(
          JSON.stringify(
            await exportReservations(
              domain,
              exportActor,
              tenant,
              "2030-01-01",
              "2030-01-02",
              otherUnit,
            ),
          ),
        ).reservations.length,
        2,
      );
      await assert.rejects(
        exportReservations(
          domain,
          exportActor,
          tenant,
          "2030-01-01",
          "2030-01-02",
        ),
        { code: "FORBIDDEN" },
      );
      await assert.rejects(
        exportReservations(
          domain,
          exportActor,
          tenant,
          "2030-01-01",
          "2030-01-02",
          unit,
        ),
        { code: "FORBIDDEN" },
      );
      const scopedDownload = await client.request(
        `${exportUrl}&unitId=${otherUnit}`,
      );
      assert.equal(scopedDownload.statusCode, 200, scopedDownload.body);
      assert.equal(scopedDownload.json().reservations.length, 2);
      assert.equal((await client.request(exportUrl)).statusCode, 403);
      assert.equal(
        (await client.request(`${exportUrl}&unitId=${unit}`)).statusCode,
        403,
      );
      await migration.query(
        "INSERT INTO domain.reservation(tenant_id,id,account_id,unit_id,calendar_version,starts_at,ends_at,status,cancellation_minutes,timezone) SELECT $1,gen_random_uuid(),$2,$3,1,'2030-01-01T02:00:00Z','2030-01-01T03:00:00Z','CANCELADA',60,'Europe/Madrid' FROM generate_series(1,9999)",
        [tenant, accountId, otherUnit],
      );
      await assert.rejects(
        exportReservations(
          domain,
          exportActor,
          tenant,
          "2030-01-01",
          "2030-01-02",
          otherUnit,
        ),
        { code: "INVALID_INPUT" },
      );
      const oversized = await client.request(
        `${exportUrl}&unitId=${otherUnit}`,
      );
      assert.equal(oversized.statusCode, 400, oversized.body);
      assert.equal(oversized.headers["content-disposition"], undefined);
      assert.equal(oversized.json().reservations, undefined);
      await migration.query(
        "DELETE FROM domain.reservation WHERE tenant_id=$1 AND id=(SELECT id FROM domain.reservation WHERE tenant_id=$1 AND unit_id=$2 AND status='CANCELADA' ORDER BY id LIMIT 1)",
        [tenant, otherUnit],
      );
      const maximum = await client.request(`${exportUrl}&unitId=${otherUnit}`);
      assert.equal(maximum.statusCode, 200, maximum.body.slice(0, 200));
      assert.equal(maximum.json().reservations.length, 10000);
      assert.equal(
        new Set(maximum.json().reservations.map((r: { id: string }) => r.id))
          .size,
        10000,
      );
      await migration.query(
        "UPDATE domain.manager_grant SET revoked_at=now() WHERE tenant_id=$1 AND invitation_id=$2",
        [tenant, managerInvitation],
      );
      await assert.rejects(
        exportReservations(
          domain,
          exportActor,
          tenant,
          "2030-01-01",
          "2030-01-02",
          otherUnit,
        ),
        { code: "FORBIDDEN" },
      );
      const revokedExport = await client.request(
        `${exportUrl}&unitId=${otherUnit}`,
      );
      assert.equal(revokedExport.statusCode, 403, revokedExport.body);
      assert.equal(revokedExport.headers["content-disposition"], undefined);
      const cookie = client.cookie();
      assert.equal(
        (await client.request("/api/auth/sign-out", {})).statusCode,
        200,
      );
      const revoked = await replica.inject({
        method: "POST",
        url,
        payload: body,
        headers: { ...headers, origin: config.origin, cookie },
      });
      assert.equal(revoked.statusCode, 401, revoked.body);
      assert.equal(
        (await replica.inject({ url: "/api/me/notices", headers: { cookie } }))
          .statusCode,
        401,
      );
    } finally {
      await Promise.all([app.close(), replica.close()]);
      for (const contract of contracts) contract.assertValid();
    }
  });
});
