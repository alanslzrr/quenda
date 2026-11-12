import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { Temporal } from "@js-temporal/polyfill";
import { buildApp } from "../../src/app.ts";
import { transaction } from "../../src/database/transaction.ts";
import { createAuthentication } from "../../src/modules/identity/index.ts";
import { browser, totp } from "../helpers/auth-client.ts";
import { withDatabase } from "../helpers/postgres.ts";
import { verifyProductResponses } from "../helpers/response-contract.ts";
import { seedMunicipalBrowser } from "../helpers/web-municipal.ts";

test("schedule recommendations repeat the holder's own habits with the next free slot", {
  timeout: 60000,
}, async () => {
  await withDatabase(async ({ auth, domain, migration }) => {
    const config = {
      origin: "http://127.0.0.1:5173",
      secret: randomBytes(32).toString("hex"),
    };
    const app = await buildApp({
      database: { check: async () => {}, close: async () => {} },
      domain,
      logLevel: "silent",
      identity: {
        config,
        authentication: createAuthentication(auth, config, {
          send: async () => {},
        }),
      },
    });
    const contract = verifyProductResponses(app);
    try {
      const f = await seedMunicipalBrowser(app, auth, domain, migration, 1);
      const zone = "Europe/Madrid";
      const today = Temporal.Now.plainDateISO(zone);
      // Tomorrow's weekday at 19:00 local is always ahead, whatever the hour of the run.
      const tomorrow = today.add({ days: 1 });
      const at = (date: Temporal.PlainDate, time: string) =>
        date.toPlainDateTime(time).toZonedDateTime(zone).toInstant().toString();
      const insert = async (
        holder: string,
        unit: string,
        date: Temporal.PlainDate,
        time: string,
        minutes: number,
        status: "CONFIRMADA" | "CANCELADA" = "CONFIRMADA",
      ) => {
        const id = randomUUID();
        await transaction(migration, async (client) => {
          await client.query(
            `INSERT INTO domain.reservation(tenant_id,id,account_id,unit_id,calendar_version,starts_at,ends_at,status,cancellation_minutes,timezone)
             VALUES($1,$2,$3,$4,1,$5::timestamptz,$5::timestamptz+make_interval(mins=>$6),$7,720,$8)`,
            [f.tenant, id, holder, unit, at(date, time), minutes, status, zone],
          );
          if (status === "CONFIRMADA")
            await client.query(
              "INSERT INTO domain.occupancy(tenant_id,id,unit_id,reservation_id,period) SELECT tenant_id,gen_random_uuid(),unit_id,id,tstzrange(starts_at,ends_at,'[)') FROM domain.reservation WHERE tenant_id=$1 AND id=$2",
              [f.tenant, id],
            );
          await client.query(
            "INSERT INTO domain.reservation_event(tenant_id,id,reservation_id,revision,kind,actor_id,correlation_id,after_state) SELECT tenant_id,gen_random_uuid(),id,1,$3,account_id,gen_random_uuid(),domain.reservation_snapshot(r) FROM domain.reservation r WHERE tenant_id=$1 AND id=$2",
            [f.tenant, id, status],
          );
        });
        return id;
      };
      const weeksAgo = (date: Temporal.PlainDate, weeks: number) =>
        date.subtract({ days: 7 * weeks });
      // A habit of three: the same unit, weekday, start and duration.
      for (const weeks of [1, 2, 3])
        await insert(
          f.accountId,
          f.unit,
          weeksAgo(tomorrow, weeks),
          "19:00",
          60,
        );
      // A habit of two on the other unit, the day after.
      const later = tomorrow.add({ days: 1 });
      for (const weeks of [1, 2])
        await insert(
          f.accountId,
          f.otherUnit,
          weeksAgo(later, weeks),
          "09:30",
          90,
        );
      // Not habits: a single booking, cancelled repetitions, and one older than six months.
      await insert(f.accountId, f.unit, weeksAgo(tomorrow, 2), "12:00", 60);
      for (const weeks of [1, 2])
        await insert(
          f.accountId,
          f.unit,
          weeksAgo(later, weeks),
          "17:00",
          60,
          "CANCELADA",
        );
      for (const weeks of [30, 31])
        await insert(f.accountId, f.unit, weeksAgo(later, weeks), "11:00", 60);

      const holder = browser(app, "192.0.2.150", config.origin);
      await holder.request("/api/auth/sign-in/email", {
        email: f.email,
        password: f.password,
      });
      await holder.request("/api/auth/two-factor/verify-totp", {
        code: totp(f.secret),
      });
      const read = async () => {
        const response = await holder.request("/api/me/recommendations");
        assert.equal(response.statusCode, 200, response.body);
        return response.json() as {
          enabled: boolean;
          items: {
            unitId: string;
            unitName: string;
            weekday: number;
            startMinute: number;
            durationMinutes: number;
            occurrences: number;
            slot: { start: { local: string }; durationMinutes: number };
          }[];
        };
      };
      const summary = (body: Awaited<ReturnType<typeof read>>) =>
        body.items.map((item) => ({
          unit: item.unitId,
          weekday: item.weekday,
          start: item.startMinute,
          minutes: item.durationMinutes,
          occurrences: item.occurrences,
          next: item.slot.start.local,
        }));

      await test("repeated confirmed bookings become recommendations, most frequent first", async () => {
        const body = await read();
        assert.equal(body.enabled, true);
        assert.deepEqual(summary(body), [
          {
            unit: f.unit,
            weekday: tomorrow.dayOfWeek,
            start: 1140,
            minutes: 60,
            occurrences: 3,
            next: `${tomorrow}T19:00`,
          },
          {
            unit: f.otherUnit,
            weekday: later.dayOfWeek,
            start: 570,
            minutes: 90,
            occurrences: 2,
            next: `${later}T09:30`,
          },
        ]);
        assert.equal(body.items[0]?.unitName, "Pista 1");
        assert.equal(body.items[0]?.slot.durationMinutes, 60);
      });

      await test("an occupied slot moves the recommendation to the next matching week", async () => {
        await insert("web-fixture", f.unit, tomorrow, "18:30", 60);
        assert.equal(
          (await read()).items[0]?.slot.start.local,
          `${tomorrow.add({ days: 7 })}T19:00`,
        );
      });

      await test("units that are no longer public are left out", async () => {
        await migration.query(
          "UPDATE domain.reservable_unit SET withdrawn_at=now() WHERE tenant_id=$1 AND id=$2",
          [f.tenant, f.otherUnit],
        );
        assert.deepEqual(
          (await read()).items.map((item) => item.unitId),
          [f.unit],
        );
      });

      await test("each account only sees its own habits", async () => {
        const other = browser(app, "192.0.2.151", config.origin);
        const second = await seedMunicipalBrowser(
          app,
          auth,
          domain,
          migration,
          2,
        );
        await other.request("/api/auth/sign-in/email", {
          email: second.email,
          password: second.password,
        });
        await other.request("/api/auth/two-factor/verify-totp", {
          code: totp(second.secret),
        });
        const response = await other.request("/api/me/recommendations");
        assert.equal(response.statusCode, 200, response.body);
        assert.deepEqual(response.json(), { enabled: true, items: [] });
        const anonymous = browser(app, "192.0.2.152", config.origin);
        assert.equal(
          (await anonymous.request("/api/me/recommendations")).statusCode,
          401,
        );
      });

      await test("the holder can turn them off, which the data download shows", async () => {
        const save = (enabled: boolean, origin = config.origin) =>
          app.inject({
            method: "PUT",
            url: "/api/me/recommendations",
            remoteAddress: "192.0.2.150",
            headers: { origin, cookie: holder.cookie() },
            payload: { enabled },
          });
        assert.equal(
          (await save(false, "https://elsewhere.test")).statusCode,
          403,
        );
        const off = await save(false);
        assert.equal(off.statusCode, 200, off.body);
        assert.deepEqual(off.json(), { enabled: false });
        assert.deepEqual(await read(), { enabled: false, items: [] });
        const record = await migration.query(
          "SELECT record FROM domain.personal_data_records($1,NULL,true,false) WHERE record_type='account'",
          [f.accountId],
        );
        assert.equal(record.rows[0].record.recommendations, false);
        assert.equal((await save(true)).statusCode, 200);
        assert.equal((await read()).items.length, 1);
      });
      contract.assertValid();
    } finally {
      await app.close();
    }
  });
});
