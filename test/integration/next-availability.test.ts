import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { Temporal } from "@js-temporal/polyfill";
import { buildApp } from "../../src/app.ts";
import { createAuthentication } from "../../src/modules/identity/index.ts";
import { createReservation } from "../../src/modules/reservations/create.ts";
import { withDatabase } from "../helpers/postgres.ts";
import { verifyProductResponses } from "../helpers/response-contract.ts";
import { initialAcceptance } from "../helpers/usage-rules-fixture.ts";
import { seedWebCatalog, webCatalog } from "../helpers/web-catalog.ts";

test("next availability suggests the first free slots after a full day", {
  timeout: 60000,
}, async () => {
  await withDatabase(async ({ auth, domain, migration }) => {
    await seedWebCatalog(auth, migration);
    // Open 10:00-12:00 local time every day, so a day holds at most two hours.
    await migration.query(
      "INSERT INTO domain.unit_calendar_version(tenant_id,unit_id,version,minimum_minutes,maximum_minutes,step_minutes,weekly,exceptions,actor_id,reason) VALUES($1,$2,2,60,120,30,$3,'[]','web-fixture','Short opening')",
      [
        webCatalog.tenant,
        webCatalog.unit,
        JSON.stringify(
          Array.from({ length: 7 }, (_, i) => ({
            day: i + 1,
            startMinute: 600,
            endMinute: 720,
          })),
        ),
      ],
    );
    await migration.query(
      "UPDATE domain.reservable_unit SET calendar_version=2 WHERE tenant_id=$1 AND id=$2",
      [webCatalog.tenant, webCatalog.unit],
    );
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
    const today = Temporal.Now.plainDateISO("Europe/Madrid");
    const day = (n: number) => today.add({ days: n }).toString();
    const at = (date: string, time: string) =>
      Temporal.PlainDateTime.from(`${date}T${time}`)
        .toZonedDateTime("Europe/Madrid")
        .toInstant()
        .toString();
    const book = (date: string, from: string, to: string) =>
      createReservation(
        domain,
        {
          accountId: "web-fixture",
          email: "fixture@example.test",
          sessionId: "synthetic",
          mfaVerifiedAt: null,
        },
        webCatalog.tenant,
        randomUUID(),
        {
          unitId: webCatalog.unit,
          startsAt: at(date, from),
          endsAt: at(date, to),
          acceptance: initialAcceptance,
        },
        randomUUID(),
        3600,
      );
    const suggest = (from: string, duration = 60) =>
      app.inject({
        url: `/api/public/municipalities/${webCatalog.tenant}/units/${webCatalog.unit}/next-availability?from=${from}&durationMinutes=${duration}`,
        remoteAddress: "192.0.2.90",
      });
    const starts = (body: { slots: { start: { local: string } }[] }) =>
      body.slots.map((slot) => slot.start.local);
    try {
      await book(day(3), "10:00", "12:00");
      await test("a full day leads to the next day's first slots", async () => {
        const response = await suggest(day(3));
        assert.equal(response.statusCode, 200, response.body);
        assert.equal(response.json().from, day(3));
        assert.deepEqual(starts(response.json()), [
          `${day(4)}T10:00`,
          `${day(4)}T10:30`,
          `${day(4)}T11:00`,
        ]);
      });
      await test("occupied slots are skipped across days", async () => {
        await book(day(4), "10:00", "11:00");
        assert.deepEqual(starts((await suggest(day(3))).json()), [
          `${day(4)}T11:00`,
          `${day(5)}T10:00`,
          `${day(5)}T10:30`,
        ]);
        assert.deepEqual(starts((await suggest(day(3), 120)).json()), [
          `${day(5)}T10:00`,
          `${day(6)}T10:00`,
          `${day(7)}T10:00`,
        ]);
      });
      await test("nothing is suggested beyond the advance limit", async () => {
        const response = await suggest(day(40));
        assert.equal(response.statusCode, 200);
        assert.deepEqual(response.json().slots, []);
      });
      await test("durations the unit does not admit are rejected", async () => {
        assert.equal((await suggest(day(3), 45)).statusCode, 400);
        assert.equal((await suggest(day(3), 30)).statusCode, 400);
      });
      contract.assertValid();
    } finally {
      await app.close();
    }
  });
});
