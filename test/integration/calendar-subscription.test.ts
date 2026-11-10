import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import Fastify from "fastify";
import ICAL from "ical.js";
import { transaction } from "../../src/database/transaction.ts";
import { registerErrors } from "../../src/http/errors.ts";
import type { Authentication } from "../../src/modules/identity/auth.ts";
import { registerCalendarSubscriptionRoutes } from "../../src/modules/reservations/calendar-subscription-routes.ts";
import { withDatabase } from "../helpers/postgres.ts";

test("a calendar subscription publishes upcoming reservations behind a revocable secret", {
  timeout: 120000,
}, async () => {
  await withDatabase(async ({ auth, domain, migration }) => {
    for (const id of ["holder", "other"])
      await auth.query(
        'INSERT INTO auth."user"(id,name,email,"emailVerified","twoFactorEnabled") VALUES($1,$1,$2,true,false)',
        [id, `${id}@example.test`],
      );
    const tenant = randomUUID(),
      facility = randomUUID(),
      unit = randomUUID();
    await migration.query(
      "INSERT INTO domain.municipality(id,name,timezone) VALUES($1,'Oleiros','Europe/Madrid')",
      [tenant],
    );
    await migration.query(
      "INSERT INTO domain.municipal_profile(tenant_id,account_id) VALUES($1,'holder'),($1,'other')",
      [tenant],
    );
    await migration.query(
      "INSERT INTO domain.facility(tenant_id,id,name,published_at) VALUES($1,$2,'Polideportivo',now())",
      [tenant, facility],
    );
    await migration.query(
      "INSERT INTO domain.reservable_unit(tenant_id,id,facility_id,name) VALUES($1,$2,$3,'Pista 1')",
      [tenant, unit, facility],
    );
    await migration.query(
      `INSERT INTO domain.unit_calendar_version(tenant_id,unit_id,version,minimum_minutes,maximum_minutes,step_minutes,weekly,exceptions,actor_id,reason)
       VALUES($1,$2,1,60,60,60,$3,'[]','holder','Fixture')`,
      [
        tenant,
        unit,
        JSON.stringify(
          Array.from({ length: 7 }, (_, day) => ({
            day: day + 1,
            startMinute: 480,
            endMinute: 1200,
          })),
        ),
      ],
    );
    const insert = async (
      holder: string,
      startsAt: string,
      status: "CONFIRMADA" | "CANCELADA",
    ) => {
      const id = randomUUID();
      await transaction(migration, async (client) => {
        await client.query(
          `INSERT INTO domain.reservation(tenant_id,id,account_id,unit_id,calendar_version,starts_at,ends_at,status,cancellation_minutes,timezone)
           VALUES($1,$2,$3,$4,1,$5::timestamptz,$5::timestamptz+interval '1 hour',$6,720,'Europe/Madrid')`,
          [tenant, id, holder, unit, startsAt, status],
        );
        if (status === "CONFIRMADA")
          await client.query(
            "INSERT INTO domain.occupancy(tenant_id,id,unit_id,reservation_id,period) SELECT tenant_id,gen_random_uuid(),unit_id,id,tstzrange(starts_at,ends_at,'[)') FROM domain.reservation WHERE tenant_id=$1 AND id=$2",
            [tenant, id],
          );
        await client.query(
          "INSERT INTO domain.reservation_event(tenant_id,id,reservation_id,revision,kind,actor_id,correlation_id,after_state) SELECT tenant_id,gen_random_uuid(),id,1,$3,account_id,gen_random_uuid(),domain.reservation_snapshot(r) FROM domain.reservation r WHERE tenant_id=$1 AND id=$2",
          [tenant, id, status],
        );
      });
      return id;
    };
    const day = (n: number) =>
      new Date(Date.UTC(2031, 0, 1 + n, 10)).toISOString();
    const first = await insert("holder", day(0), "CONFIRMADA");
    const second = await insert("holder", day(1), "CONFIRMADA");
    await insert("holder", day(2), "CANCELADA");
    await insert("holder", "2024-01-01T10:00:00Z", "CONFIRMADA");
    await insert("other", day(3), "CONFIRMADA");

    let current: string | null = "holder";
    const authentication = {
      authenticate: async () =>
        current
          ? {
              accountId: current,
              email: `${current}@example.test`,
              sessionId: current,
              mfaVerifiedAt: null,
            }
          : null,
    } as unknown as Authentication;
    const config = { origin: "https://quenda.test", secret: "feed-secret" };
    const app = Fastify({
      genReqId: () => randomUUID(),
      ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
    });
    registerErrors(app);
    await registerCalendarSubscriptionRoutes(
      app,
      domain,
      authentication,
      config,
    );
    const origin = { origin: config.origin };
    const create = async (lang?: "es" | "gl") => {
      const response = await app.inject({
        method: "POST",
        url: "/api/me/calendar-subscription",
        headers: origin,
        payload: lang ? { lang } : {},
      });
      assert.equal(response.statusCode, 200, response.body);
      return response.json() as {
        url: string;
        webcalUrl: string;
        createdAt: string;
      };
    };
    const feed = (url: string, ip = "192.0.2.10") =>
      app.inject({
        url: new URL(url).pathname + new URL(url).search,
        remoteAddress: ip,
      });
    const events = (body: string) =>
      new ICAL.Component(ICAL.parse(body))
        .getAllSubcomponents("vevent")
        .map((event) => String(event.getFirstPropertyValue("uid")));

    try {
      await test("nothing is published until the holder asks, and only with the configured origin", async () => {
        assert.deepEqual(
          (await app.inject("/api/me/calendar-subscription")).json(),
          { active: false, createdAt: null },
        );
        const forged = await app.inject({
          method: "POST",
          url: "/api/me/calendar-subscription",
          headers: { origin: "https://elsewhere.test" },
          payload: {},
        });
        assert.equal(forged.statusCode, 403);
        current = null;
        assert.equal(
          (
            await app.inject({
              method: "POST",
              url: "/api/me/calendar-subscription",
              headers: origin,
              payload: {},
            })
          ).statusCode,
          401,
        );
        current = "holder";
      });

      let subscription = await create("gl");
      const token = /\/api\/calendars\/([A-Za-z0-9_-]{43})\.ics\?lang=gl$/.exec(
        subscription.url,
      )?.[1];

      await test("the URL is shown once and the database keeps only its digest", async () => {
        assert.ok(token, subscription.url);
        assert.ok(subscription.url.startsWith("https://quenda.test/"));
        assert.equal(
          subscription.webcalUrl,
          subscription.url.replace("https:", "webcal:"),
        );
        const status = (
          await app.inject("/api/me/calendar-subscription")
        ).json();
        assert.equal(status.active, true);
        assert.ok(!JSON.stringify(status).includes(token as string));
        const stored = await migration.query(
          "SELECT to_jsonb(s) AS row FROM domain.calendar_subscription s WHERE account_id='holder'",
        );
        assert.equal(stored.rowCount, 1);
        assert.ok(
          !JSON.stringify(stored.rows[0].row).includes(token as string),
        );
        const digest = await migration.query(
          "SELECT token_hash FROM domain.calendar_subscription WHERE account_id='holder'",
        );
        assert.deepEqual(
          digest.rows[0].token_hash,
          createHash("sha256")
            .update(token as string)
            .digest(),
        );
        await assert.rejects(
          domain.query("SELECT * FROM domain.calendar_subscription"),
          /permission denied/,
        );
      });

      await test("the feed holds the holder's upcoming confirmed reservations and nothing else", async () => {
        const response = await feed(subscription.url);
        assert.equal(response.statusCode, 200, response.body);
        assert.match(
          String(response.headers["content-type"]),
          /^text\/calendar/,
        );
        assert.equal(response.headers["cache-control"], "private, no-store");
        assert.deepEqual(events(response.body), [
          `${first}@quenda.test`,
          `${second}@quenda.test`,
        ]);
        assert.ok(
          response.body.includes("X-WR-CALNAME:As miñas reservas de Quenda"),
        );
        const spanish = await feed(
          subscription.url.replace("lang=gl", "lang=es"),
        );
        assert.ok(spanish.body.includes("X-WR-CALNAME:Mis reservas de Quenda"));
      });

      await test("unknown, malformed and replaced URLs answer 404", async () => {
        const unknown = `https://quenda.test/api/calendars/${"A".repeat(43)}.ics`;
        assert.equal((await feed(unknown)).statusCode, 404);
        assert.equal(
          (await app.inject("/api/calendars/short.ics")).statusCode,
          400,
        );
        const previous = subscription.url;
        subscription = await create();
        assert.notEqual(subscription.url, previous);
        assert.equal((await feed(previous)).statusCode, 404);
        assert.equal((await feed(subscription.url)).statusCode, 200);
      });

      await test("revoking stops the URL at once", async () => {
        const revoke = () =>
          app.inject({
            method: "POST",
            url: "/api/me/calendar-subscription/revoke",
            headers: origin,
          });
        assert.deepEqual((await revoke()).json(), { revoked: true });
        assert.equal((await feed(subscription.url)).statusCode, 404);
        assert.deepEqual((await revoke()).json(), { revoked: false });
        assert.deepEqual(
          (await app.inject("/api/me/calendar-subscription")).json(),
          { active: false, createdAt: null },
        );
      });

      await test("deactivation withdraws the subscription and reactivation does not restore it", async () => {
        subscription = await create();
        await migration.query(
          "UPDATE auth.account_lifecycle SET deactivated_at=now() WHERE account_id='holder'",
        );
        assert.equal(
          (
            await migration.query(
              "SELECT 1 FROM domain.calendar_subscription WHERE account_id='holder'",
            )
          ).rowCount,
          0,
        );
        assert.equal((await feed(subscription.url)).statusCode, 404);
        await migration.query(
          "UPDATE auth.account_lifecycle SET deactivated_at=NULL WHERE account_id='holder'",
        );
        assert.equal((await feed(subscription.url)).statusCode, 404);
      });

      await test("the personal data download lists the subscription date but not the secret", async () => {
        const created = await create();
        const records = await migration.query(
          "SELECT record_type,record FROM domain.personal_data_records('holder',NULL,true,false) WHERE record_type='calendarSubscription'",
        );
        assert.equal(records.rowCount, 1);
        assert.deepEqual(Object.keys(records.rows[0].record), ["createdAt"]);
        assert.equal(
          new Date(records.rows[0].record.createdAt).toISOString(),
          created.createdAt,
        );
      });

      await test("one URL is limited per minute even when requests share an address", async () => {
        const created = await create();
        for (let attempt = 0; attempt < 60; attempt++)
          assert.equal(
            (await feed(created.url, `192.0.2.${(attempt % 200) + 1}`))
              .statusCode,
            200,
          );
        const limited = await feed(created.url, "198.51.100.7");
        assert.equal(limited.statusCode, 429);
        assert.ok(Number(limited.headers["retry-after"]) > 0);
        // Another holder behind the same address is unaffected.
        current = "other";
        const other = await create();
        assert.equal((await feed(other.url, "198.51.100.7")).statusCode, 200);
        current = "holder";
      });

      await test("guessing secrets from one address is slowed down", async () => {
        let last = 0;
        for (let attempt = 0; attempt < 61; attempt++) {
          const guess = randomUUID().replaceAll("-", "").padEnd(43, "x");
          last = (
            await feed(
              `https://quenda.test/api/calendars/${guess}.ics`,
              "203.0.113.9",
            )
          ).statusCode;
        }
        assert.equal(last, 429);
      });
    } finally {
      await app.close();
    }
  });
});
