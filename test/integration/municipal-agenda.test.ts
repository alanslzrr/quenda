import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { buildApp } from "../../src/app.ts";
import { transaction } from "../../src/database/transaction.ts";
import { createAuthentication } from "../../src/modules/identity/index.ts";
import {
  acceptManager,
  inviteManager,
} from "../../src/modules/identity/manager.ts";
import { browser, totp } from "../helpers/auth-client.ts";
import { withDatabase } from "../helpers/postgres.ts";
import { verifyProductResponses } from "../helpers/response-contract.ts";
import { seedMunicipalBrowser } from "../helpers/web-municipal.ts";

test("municipal agenda filters before paging, isolates grants and preserves occupancy during administrative previews", {
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
      const other = await seedMunicipalBrowser(app, auth, domain, migration, 2);
      const client = browser(app, "192.0.2.199", config.origin);
      await client.request("/api/auth/sign-in/email", {
        email: f.email,
        password: f.password,
      });
      await client.request("/api/auth/two-factor/verify-totp", {
        code: totp(f.secret),
      });
      const base = `/api/municipalities/${f.tenant}`;
      const unitResponse = await client.request(`${base}/agenda/units`);
      assert.equal(unitResponse.statusCode, 200, unitResponse.body);
      assert.equal(unitResponse.json().items.length, 2);
      assert.equal(
        (
          await client.request(
            `/api/municipalities/${other.tenant}/agenda/units`,
          )
        ).json().items.length,
        0,
      );
      const list = await client.request(`${base}/reservations?date=${f.date}`);
      assert.equal(list.statusCode, 200, list.body);
      assert.equal(list.json().items[0].id, f.reservationId);
      assert.equal(
        (await client.request(`${base}/reservations?date=2000-01-01`)).json()
          .items.length,
        0,
      );
      assert.equal(
        (
          await client.request(
            `${base}/reservations?date=${f.date}&unitId=${f.otherUnit}`,
          )
        ).json().items.length,
        0,
      );
      assert.equal(
        (await client.request(`${base}/reservations?date=invalid`)).statusCode,
        400,
      );
      const availability = `${base}/reservations/${f.reservationId}/availability?administrative=true&unitId=${f.unit}&date=${f.date}&durationMinutes=60`;
      const slots = await client.request(availability);
      assert.equal(slots.statusCode, 200, slots.body);
      assert.ok(
        slots
          .json()
          .slots.some(
            (s: { start: { utc: string } }) =>
              s.start.utc === `${f.date}T10:00:00.000Z`,
          ),
      );
      assert.equal(
        (
          await client.request(
            availability.replace("administrative=true", "administrative=false"),
          )
        ).statusCode,
        404,
      );
      assert.equal(
        (
          await client.request(
            availability.replace(`unitId=${f.unit}`, `unitId=${other.unit}`),
          )
        ).statusCode,
        404,
      );
      // A block crossing midnight belongs to both civil dates, independent of UTC.
      const created = await client.request(
        `${base}/blocks`,
        {
          unitId: f.otherUnit,
          startsAt: `${f.date}T21:30:00Z`,
          endsAt: `${f.date}T23:30:00Z`,
          reason: "Synthetic maintenance",
        },
        { "idempotency-key": randomUUID() },
      );
      assert.equal(created.statusCode, 201, created.body);
      const blocks = await client.request(`${base}/blocks?date=${f.date}`);
      assert.equal(blocks.statusCode, 200, blocks.body);
      assert.equal(blocks.json().items[0].id, created.json().id);
      const next = new Date(`${f.date}T12:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      assert.equal(
        (
          await client.request(
            `${base}/blocks?date=${next.toISOString().slice(0, 10)}`,
          )
        ).json().items.length,
        1,
      );
      assert.equal(
        (
          await client.request(`${base}/blocks?date=${f.date}&unitId=${f.unit}`)
        ).json().items.length,
        0,
      );
      assert.equal(
        (
          await client.request(`/api/municipalities/${other.tenant}/blocks`)
        ).json().items.length,
        0,
      );
      const released = await client.request(
        `${base}/blocks/${created.json().id}/release`,
        { reason: "Completed" },
        { "idempotency-key": randomUUID() },
      );
      assert.equal(released.statusCode, 200, released.body);
      assert.ok(
        (await client.request(`${base}/blocks?date=${f.date}`)).json().items[0]
          .releasedAt,
      );
      assert.equal(
        (await app.inject({ url: `${base}/agenda/units` })).statusCode,
        401,
      );

      const ids = await auth.query<{ id: string; email: string }>(
        'SELECT id,email FROM auth."user" WHERE email=ANY($1)',
        [[f.email, other.email]],
      );
      const actor = (email: string) => {
        const found = ids.rows.find((r) => r.email === email);
        assert.ok(found);
        return {
          accountId: found.id,
          email,
          sessionId: "synthetic",
          mfaVerifiedAt: new Date(),
        };
      };
      const invitation = await inviteManager(domain, actor(f.email), f.tenant, {
        email: other.email,
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        permissions: [
          { operation: "RESERVATION_READ", unitId: f.unit },
          { operation: "UNIT_BLOCK", unitId: f.otherUnit },
        ],
      });
      await acceptManager(
        domain,
        actor(other.email),
        f.tenant,
        invitation.invitationId,
      );
      const reader = browser(app, "192.0.2.200", config.origin);
      await reader.request("/api/auth/sign-in/email", {
        email: other.email,
        password: other.password,
      });
      await reader.request("/api/auth/two-factor/verify-totp", {
        code: totp(other.secret),
      });
      assert.equal(
        (await reader.request(`${base}/agenda/units`)).json().items.length,
        2,
      );
      assert.equal(
        (await reader.request(`${base}/reservations?date=${f.date}`)).json()
          .items.length,
        1,
      );
      assert.equal((await reader.request(availability)).statusCode, 403);
      const denied = await transaction(
        domain,
        (c) =>
          c.query(
            "SELECT * FROM domain.administrative_reservation_available_slots($1,$2,$3,ARRAY[$4::timestamptz],ARRAY[$5::timestamptz])",
            [
              f.tenant,
              f.unit,
              f.reservationId,
              `${f.date}T10:00:00Z`,
              `${f.date}T11:00:00Z`,
            ],
          ),
        { accountId: actor(other.email).accountId, tenantId: f.tenant },
      );
      assert.equal(denied.rowCount, 0);
      for (let i = 0; i < 23; i++)
        await migration.query(
          "INSERT INTO domain.reservable_unit(tenant_id,id,facility_id,name) VALUES($1,$2,$3,$4)",
          [f.tenant, randomUUID(), f.facility, `Scoped page ${i}`],
        );
      const first = (await client.request(`${base}/agenda/units`)).json();
      assert.equal(first.items.length, 20);
      assert.ok(first.nextCursor);
      const second = (
        await client.request(`${base}/agenda/units?after=${first.nextCursor}`)
      ).json();
      assert.equal(second.items.length, 5);
      assert.equal(second.nextCursor, null);
      assert.equal(
        new Set([...first.items, ...second.items].map((r) => r.id)).size,
        25,
      );
      // Filtering authority happens before LIMIT: unrelated drafts never fill a reader's page.
      const scoped = (await reader.request(`${base}/agenda/units`)).json();
      assert.equal(scoped.items.length, 2);
      assert.equal(scoped.nextCursor, null);
      await migration.query(
        "UPDATE domain.manager_grant SET revoked_at=now() WHERE tenant_id=$1 AND invitation_id=$2",
        [f.tenant, invitation.invitationId],
      );
      assert.equal(
        (await reader.request(`${base}/agenda/units`)).json().items.length,
        0,
      );
      assert.equal(
        (await reader.request(`${base}/reservations?date=${f.date}`)).json()
          .items.length,
        0,
      );
      contract.assertValid();
    } finally {
      await app.close();
    }
  });
});
