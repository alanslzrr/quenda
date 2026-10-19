import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { buildApp } from "../../src/app.ts";
import { createAuthentication } from "../../src/modules/identity/index.ts";
import type { MailMessage } from "../../src/shared/mail.ts";
import { browser } from "../helpers/auth-client.ts";
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
    } finally {
      await Promise.all([app.close(), replica.close()]);
    }
  });
});
