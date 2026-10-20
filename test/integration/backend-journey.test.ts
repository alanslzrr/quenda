import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { initializeOperator } from "../../scripts/lib/initialize-operator.ts";
import { buildApp } from "../../src/app.ts";
import { processReservationEmail } from "../../src/modules/communications/index.ts";
import { createAuthentication } from "../../src/modules/identity/index.ts";
import type { MailMessage } from "../../src/shared/mail.ts";
import { browser, totp } from "../helpers/auth-client.ts";
import { withDatabase } from "../helpers/postgres.ts";

test("clean backend journey onboards users and municipality, publishes resources and completes booking lifecycle through HTTP", {
  timeout: 90000,
}, async () => {
  await withDatabase(async ({ auth, domain, migration, worker }) => {
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
    const app = await buildApp({
      database: { check: async () => {}, close: async () => {} },
      domain,
      logLevel: "silent",
      identity: {
        authentication: createAuthentication(auth, config, mail),
        config,
      },
    });
    const ok = (
      response: Awaited<ReturnType<ReturnType<typeof browser>["request"]>>,
      expected = 200,
    ) => {
      assert.equal(response.statusCode, expected, response.body);
      return response.json();
    };
    try {
      const register = async (name: string, address: string, mfa: boolean) => {
        const client = browser(app, address),
          email = `${name}@example.test`,
          password = "Synthetic-journey-password-123!";
        const user = ok(
          await client.request("/api/auth/sign-up/email", {
            name,
            email,
            password,
          }),
        ).user;
        const message = messages.find(
          (item) => item.to === email && item.text.includes("verify-email"),
        );
        assert.ok(message);
        const link = new URL(message.text.trim().split("\n").at(-1) ?? "");
        assert.ok(
          [200, 302].includes(
            (await client.request(link.pathname + link.search)).statusCode,
          ),
        );
        ok(
          await client.request("/api/auth/sign-in/email", { email, password }),
        );
        if (mfa) {
          const enrolled = ok(
            await client.request("/api/auth/two-factor/enable", { password }),
          );
          const secret = new URL(enrolled.totpURI).searchParams.get("secret");
          assert.ok(secret);
          ok(
            await client.request("/api/auth/two-factor/verify-totp", {
              code: totp(secret),
            }),
          );
        }
        return { client, id: user.id as string };
      };
      const operator = await register("operator", "192.0.2.201", true);
      const admin = await register("administrator", "192.0.2.202", true);
      const citizen = await register("citizen", "192.0.2.203", false);
      // Sole administrative bootstrap; all product data and user actions use HTTP.
      const owner = new Client({
        connectionString: migration.options.connectionString,
      });
      await owner.connect();
      try {
        await initializeOperator(owner, operator.id);
      } finally {
        await owner.end();
      }
      const municipality = ok(
        await operator.client.request("/api/municipalities", {
          name: "Journey municipality",
          timezone: "Europe/Madrid",
          administratorId: admin.id,
          invitationExpiresAt: new Date(Date.now() + 3600000).toISOString(),
        }),
        201,
      );
      const base = `/api/municipalities/${municipality.tenantId}`;
      ok(
        await admin.client.request(
          `${base}/administrator-invitations/${municipality.invitationId}/accept`,
          {},
        ),
      );
      const facility = ok(
        await admin.client.request(`${base}/facilities`, {
          name: "Journey facility",
        }),
        201,
      );
      const unit = ok(
        await admin.client.request(
          `${base}/facilities/${facility.facilityId}/units`,
          { name: "Journey court" },
        ),
        201,
      );
      ok(
        await app.inject({
          method: "PUT",
          url: `${base}/units/${unit.unitId}/calendar`,
          headers: { origin: config.origin, cookie: admin.client.cookie() },
          payload: {
            expectedVersion: 0,
            reason: "Initial availability",
            calendar: {
              minimumMinutes: 60,
              maximumMinutes: 120,
              stepMinutes: 60,
              advanceDays: null,
              weekly: Array.from({ length: 7 }, (_, i) => ({
                day: i + 1,
                startMinute: 0,
                endMinute: 1440,
              })),
              exceptions: [],
            },
          },
        }),
      );
      ok(
        await admin.client.request(
          `${base}/facilities/${facility.facilityId}/publish`,
          { reason: "Open facility" },
        ),
      );
      ok(
        await admin.client.request(`${base}/units/${unit.unitId}/publish`, {
          reason: "Open independent court",
          calendarVersion: 1,
          independenceConfirmed: true,
        }),
      );
      const start = new Date();
      start.setUTCDate(start.getUTCDate() + 2);
      start.setUTCHours(10, 0, 0, 0);
      const availability = `/api/public/municipalities/${municipality.tenantId}/units/${unit.unitId}/availability?date=${start.toISOString().slice(0, 10)}&durationMinutes=60`;
      const available = async () =>
        ok(await citizen.client.request(availability)).slots.map(
          (slot: { start: { utc: string } }) => slot.start.utc,
        ) as string[];
      assert.ok((await available()).includes(start.toISOString()));
      const input = {
        unitId: unit.unitId,
        startsAt: start.toISOString(),
        endsAt: new Date(start.getTime() + 3600000).toISOString(),
      };
      const created = ok(
        await citizen.client.request(`${base}/reservations`, input, {
          "idempotency-key": "journey-create",
        }),
        201,
      );
      assert.ok(!(await available()).includes(input.startsAt));
      const reservation = `${base}/reservations/${created.id}`;
      assert.equal(
        ok(await citizen.client.request(reservation)).status,
        "CONFIRMADA",
      );
      const changed = ok(
        await citizen.client.request(
          `${reservation}/modify`,
          {
            ...input,
            startsAt: new Date(start.getTime() + 3600000).toISOString(),
            endsAt: new Date(start.getTime() + 7200000).toISOString(),
            expectedRevision: 1,
          },
          { "idempotency-key": "journey-modify" },
        ),
      );
      assert.equal(changed.revision, 2);
      const afterChange = await available();
      assert.ok(afterChange.includes(input.startsAt));
      assert.ok(!afterChange.includes(changed.startsAt));
      const cancelled = ok(
        await citizen.client.request(
          `${reservation}/cancel`,
          { expectedRevision: 2 },
          { "idempotency-key": "journey-cancel" },
        ),
      );
      assert.equal(cancelled.status, "CANCELADA");
      assert.equal(cancelled.revision, 3);
      assert.ok((await available()).includes(changed.startsAt));
      const from = start.toISOString().slice(0, 10),
        to = new Date(start.getTime() + 86400000).toISOString().slice(0, 10);
      const exported = ok(
        await admin.client.request(
          `${base}/exports/reservations?from=${from}&to=${to}`,
        ),
      );
      assert.equal(exported.reservations.length, 1);
      assert.equal(exported.reservations[0].id, created.id);
      assert.equal(exported.reservations[0].status, "CANCELADA");
      const notices = ok(await citizen.client.request("/api/me/notices"));
      assert.equal(notices.items.length, 3);
      assert.deepEqual(
        notices.items.map((notice: { kind: string }) => notice.kind).sort(),
        ["CANCELADA", "CONFIRMADA", "MODIFICADA"],
      );
      const beforeMail = messages.length;
      for (let i = 0; i < 3; i++)
        await processReservationEmail(worker, mail, {
          origin: config.origin,
          locale: "es",
          leaseSeconds: 30,
          maxAttempts: 3,
          retrySeconds: 1,
        });
      assert.equal(messages.length - beforeMail, 3);
      assert.ok(
        messages
          .slice(beforeMail)
          .every((item) => item.to === "citizen@example.test"),
      );
      assert.equal(
        (await operator.client.request(reservation)).statusCode,
        404,
      );
    } finally {
      await app.close();
    }
  });
});
