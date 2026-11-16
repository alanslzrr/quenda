import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { buildApp } from "../../src/app.ts";
import { createAuthentication } from "../../src/modules/identity/index.ts";
import { seedCloudDemo } from "../demo/cloud.ts";
import { withDatabase } from "../helpers/postgres.ts";

test("the cloud demo seeds every role, eight weeks of history and no pending mail", {
  timeout: 600000,
}, async () => {
  await withDatabase(async ({ auth, domain, migration }) => {
    const config = {
      origin: "https://quenda.test",
      secret: randomBytes(32).toString("hex"),
    };
    const sent: unknown[] = [];
    const app = await buildApp({
      database: { check: async () => {}, close: async () => {} },
      domain,
      identity: {
        authentication: createAuthentication(auth, config, {
          async send(message) {
            sent.push(message);
          },
        }),
        config,
      },
      logLevel: "warn",
    });
    try {
      const access = await seedCloudDemo(
        app,
        { auth, domain, migration },
        { origin: config.origin, password: "Demo-cloud-password-2026" },
      );
      assert.equal(access.accounts.length, 13);
      assert.equal(
        access.accounts.filter((entry) => entry.totp?.startsWith("otpauth://"))
          .length,
        4,
      );
      assert.match(String(access.calendarSubscription?.url ?? ""), /^https:/);

      const { rows } = await migration.query<Record<string, number>>(`
        SELECT
          (SELECT count(*) FROM domain.platform_operator)::int AS operators,
          (SELECT count(*) FROM domain.municipal_administrator)::int AS administrators,
          (SELECT count(*) FROM domain.reservation WHERE ends_at < now())::int AS past,
          (SELECT count(*) FROM domain.reservation WHERE starts_at > now())::int AS future,
          (SELECT count(*) FROM domain.reservation WHERE status='CANCELADA')::int AS cancelled,
          (SELECT count(*) FROM domain.reservation WHERE arrived_at IS NOT NULL)::int AS arrivals,
          (SELECT count(*) FROM domain.reservation WHERE created_at < now() - interval '40 days')::int AS old_bookings,
          (SELECT count(*) FROM domain.schedule_block)::int AS blocks,
          (SELECT count(*) FROM domain.reservation_email WHERE accepted_at IS NULL)::int AS pending_mail,
          (SELECT count(*) FROM domain.reservation_notice WHERE read_at IS NULL)::int AS unread
      `);
      const counts = rows[0] as Record<string, number>;
      assert.equal(counts.operators, 1);
      assert.equal(counts.administrators, 2);
      assert.ok((counts.past ?? 0) > 400, `past ${counts.past}`);
      assert.ok((counts.future ?? 0) > 100, `future ${counts.future}`);
      assert.ok((counts.cancelled ?? 0) > 20, `cancelled ${counts.cancelled}`);
      assert.ok((counts.arrivals ?? 0) > 200, `arrivals ${counts.arrivals}`);
      assert.ok((counts.old_bookings ?? 0) > 100, "history is backdated");
      assert.equal(counts.blocks, 1);
      assert.equal(counts.pending_mail, 0);
      assert.ok((counts.unread ?? 0) > 0, "recent notices stay unread");

      const branding = await app.inject({
        method: "GET",
        url: "/api/public/municipalities/00000000-0000-4000-8000-00000000d100",
        remoteAddress: "198.51.100.200",
      });
      assert.equal(branding.statusCode, 200, branding.body);
      assert.match(branding.body, /Concello de Valdeira/);
    } finally {
      await app.close();
    }
  });
});
