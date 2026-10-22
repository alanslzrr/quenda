import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { buildApp } from "../../src/app.ts";
import { createAuthentication } from "../../src/modules/identity/index.ts";
import type { MailMessage } from "../../src/shared/mail.ts";
import { browser } from "../helpers/auth-client.ts";
import { withDatabase } from "../helpers/postgres.ts";
import { verifyProductResponses } from "../helpers/response-contract.ts";
import { initialAcceptance } from "../helpers/usage-rules-fixture.ts";
import { webCatalog as f, seedWebCatalog } from "../helpers/web-catalog.ts";

test("reservation recovery policy and own rescheduling expose validated no-store HTTP contracts", {
  timeout: 60000,
}, async () => {
  await withDatabase(async ({ auth, domain, migration }) => {
    await seedWebCatalog(auth, migration);
    const messages: MailMessage[] = [];
    const config = {
      origin: "https://quenda.test",
      secret: randomBytes(32).toString("hex"),
    };
    const app = await buildApp({
      database: { check: async () => {}, close: async () => {} },
      domain,
      logLevel: "silent",
      idempotencyRetentionSeconds: 3600,
      identity: {
        config,
        authentication: createAuthentication(auth, config, {
          send: async (message) => {
            messages.push(message);
          },
        }),
      },
    });
    const contract = verifyProductResponses(app);
    try {
      const client = browser(app, "192.0.2.170");
      const email = "availability@example.test",
        password = "Synthetic-password-1234!";
      assert.equal(
        (
          await client.request("/api/auth/sign-up/email", {
            name: "Ana",
            email,
            password,
          })
        ).statusCode,
        200,
      );
      const message = messages.find((m) => m.text.includes("verify-email"));
      assert.ok(message);
      const link = new URL(message.text.trim().split("\n").at(-1) ?? "");
      assert.ok(
        [200, 302].includes(
          (await client.request(link.pathname + link.search)).statusCode,
        ),
      );
      assert.equal(
        (await client.request("/api/auth/sign-in/email", { email, password }))
          .statusCode,
        200,
      );
      const date = new Date(Date.now() + 3 * 86400000)
        .toISOString()
        .slice(0, 10);
      const created = await client.request(
        `/api/municipalities/${f.tenant}/reservations`,
        {
          unitId: f.unit,
          startsAt: `${date}T10:00:00Z`,
          endsAt: `${date}T11:00:00Z`,
          acceptance: initialAcceptance,
        },
        { "idempotency-key": randomUUID() },
      );
      assert.equal(created.statusCode, 201, created.body);
      const policy = await app.inject({
        url: "/api/public/reservation-command-policy",
      });
      assert.equal(policy.statusCode, 200, policy.body);
      assert.equal(policy.headers["cache-control"], "no-store");
      assert.equal(policy.json().retentionSeconds, 3600);
      assert.ok(
        Math.abs(Date.parse(policy.json().serverTime) - Date.now()) < 10000,
      );
      const url = `/api/municipalities/${f.tenant}/reservations/${created.json().id}/availability?unitId=${f.unit}&date=${date}&durationMinutes=60`;
      assert.equal((await app.inject({ url })).statusCode, 401);
      const available = await client.request(url);
      assert.equal(available.statusCode, 200, available.body);
      assert.equal(available.headers["cache-control"], "no-store");
      assert.ok(
        available
          .json()
          .slots.some(
            (s: { start: { utc: string } }) =>
              Date.parse(s.start.utc) === Date.parse(`${date}T10:30:00Z`),
          ),
      );
      assert.equal(
        (await client.request(url.replace(created.json().id, randomUUID())))
          .statusCode,
        404,
      );
      assert.equal(
        (
          await client.request(
            url.replace("durationMinutes=60", "durationMinutes=invalid"),
          )
        ).statusCode,
        400,
      );
      contract.assertValid();
    } finally {
      await app.close();
    }
  });
});
