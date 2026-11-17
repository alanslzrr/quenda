import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { buildApp } from "../../src/app.ts";
import { createAuthentication } from "../../src/modules/identity/index.ts";
import { seedCloudDemo } from "../demo/cloud.ts";
import { withDatabase } from "../helpers/postgres.ts";

test("the cloud demo seeds every role, a coherent history and no pending mail", {
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
      const seededAt = new Date();
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

      // Nothing seeded happens after the seeding: bookings, events, notices.
      const { rows: timeline } = await migration.query<Record<string, number>>(
        `SELECT
          (SELECT count(*) FROM domain.reservation WHERE created_at > $1)::int AS bookings,
          (SELECT count(*) FROM domain.reservation_event WHERE occurred_at > $1)::int AS events,
          (SELECT count(*) FROM domain.reservation_notice
            WHERE created_at > $1 OR read_at > $1)::int AS notices,
          (SELECT count(*) FROM domain.reservation_event c
             JOIN domain.reservation_event b ON (b.tenant_id,b.reservation_id,b.revision)=(c.tenant_id,c.reservation_id,1)
             JOIN domain.reservation r ON (r.tenant_id,r.id)=(c.tenant_id,c.reservation_id)
            WHERE c.kind='CANCELADA' AND NOT (c.occurred_at > b.occurred_at AND c.occurred_at < r.starts_at))::int AS cancellations,
          (SELECT count(*) FROM domain.reservation_event e
             JOIN domain.reservation r ON (r.tenant_id,r.id)=(e.tenant_id,e.reservation_id)
            WHERE e.revision=1 AND e.occurred_at<>r.created_at)::int AS creations,
          (SELECT count(*) FROM domain.reservation_notice n
             JOIN domain.reservation_event e ON (e.tenant_id,e.id)=(n.tenant_id,n.event_id)
            WHERE n.created_at<>e.occurred_at)::int AS notice_times`,
        [seededAt],
      );
      assert.deepEqual(timeline[0], {
        bookings: 0,
        events: 0,
        notices: 0,
        cancellations: 0,
        creations: 0,
        notice_times: 0,
      });

      // Conditions were accepted when the booking was made, before it started.
      const { rows: acceptance } = await migration.query<
        Record<string, number>
      >(
        `SELECT
          count(*) FILTER (WHERE ends_at < $1)::int AS past,
          count(*) FILTER (WHERE rules_accepted_at IS DISTINCT FROM created_at
            OR conditions_accepted_at IS DISTINCT FROM created_at
            OR rules_accepted_at > starts_at)::int AS incoherent,
          (SELECT count(*) FROM domain.reservation_event e
             JOIN domain.reservation r ON (r.tenant_id,r.id)=(e.tenant_id,e.reservation_id)
            WHERE (e.after_state->>'rulesAcceptedAt')::timestamptz<>r.rules_accepted_at
               OR (e.after_state->>'conditionsAcceptedAt')::timestamptz<>r.conditions_accepted_at)::int AS snapshots
         FROM domain.reservation`,
        [seededAt],
      );
      assert.ok((acceptance[0]?.past ?? 0) > 400);
      assert.equal(acceptance[0]?.incoherent, 0);
      assert.equal(acceptance[0]?.snapshots, 0);

      const branding = await app.inject({
        method: "GET",
        url: "/api/public/municipalities/00000000-0000-4000-8000-00000000d100",
        remoteAddress: "198.51.100.200",
      });
      assert.equal(branding.statusCode, 200, branding.body);
      assert.match(branding.body, /Concello de Valdeira/);
      // No theme is preinstalled: each administration configures its own.
      const { rows: appearance } = await migration.query<{
        version: number;
        theme: string;
      }>(
        "SELECT appearance_version AS version, theme FROM domain.municipality ORDER BY id",
      );
      assert.deepEqual(
        appearance.map((row) => [row.version, row.theme]),
        [
          [1, "neutral"],
          [1, "neutral"],
        ],
      );
    } finally {
      await app.close();
    }
  });
});
