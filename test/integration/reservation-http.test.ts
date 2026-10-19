import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { buildApp } from "../../src/app.ts";
import { createAuthentication } from "../../src/modules/identity/index.ts";
import type { MailMessage } from "../../src/shared/mail.ts";
import { browser, totp } from "../helpers/auth-client.ts";
import { withDatabase } from "../helpers/postgres.ts";

test("reservation HTTP uses verified sessions, origin checks and replay across replicas", {
  timeout: 60000,
}, async () => {
  await withDatabase(async ({ domain, auth, migration }) => {
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
        "INSERT INTO domain.municipality(id,name,timezone) VALUES($1,'Synthetic','Europe/Madrid')",
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
      await migration.query(
        "UPDATE domain.reservable_unit SET calendar_version=1,published_at=now() WHERE tenant_id=$1 AND id=$2",
        [tenant, unit],
      );
      const start = new Date();
      start.setUTCDate(start.getUTCDate() + 1);
      start.setUTCHours(10, 0, 0, 0);
      const body = {
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
    }
  });
});
