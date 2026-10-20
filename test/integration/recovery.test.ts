import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { Client, Pool } from "pg";
import { createBackup } from "../../scripts/lib/backup.ts";
import { migrate } from "../../scripts/lib/migrations.ts";
import { assertRuntimeRole } from "../../src/database/pools.ts";
import {
  cancelReservation,
  createReservation,
  readReservation,
} from "../../src/modules/reservations/index.ts";
import { withDatabase } from "../helpers/postgres.ts";
import { recoveryFixture } from "../helpers/recovery-fixture.ts";

const execute = promisify(execFile);
const tables = [
  'auth."user"',
  "auth.session",
  "auth.account",
  "auth.session_event",
  "auth.credential_event",
  "auth.request_event",
  "domain.municipality",
  "domain.facility",
  "domain.reservable_unit",
  "domain.unit_calendar_version",
  "domain.reservation",
  "domain.occupancy",
  "domain.reservation_event",
  "domain.reservation_notice",
  "domain.reservation_email",
  "domain.idempotent_command",
  "domain.agreement",
  "domain.agreement_version",
  "domain.agreement_participant",
  "domain.agreement_activation",
  "domain.agreement_assignment",
  "domain.unit_agreement_gate",
  "domain.agreement_subject",
  "domain.agreement_consumption",
  "domain.agreement_consumption_event",
  "quenda_meta.migrations",
];
const snapshot = async (pool: Pool) =>
  Object.fromEntries(
    await Promise.all(
      tables.map(async (table) => [
        table,
        (
          await pool.query(
            `SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`,
          )
        ).rows,
      ]),
    ),
  );

test("independent-cluster restore preserves bookings, quotas and evidence without copying role passwords", {
  timeout: 90000,
}, async (t) => {
  await withDatabase(async (source) => {
    const { tenants, units } = await recoveryFixture(
      source.auth,
      source.migration,
    );
    const actor = {
      accountId: "citizen",
      email: "citizen@example.test",
      sessionId: "fixture",
      mfaVerifiedAt: null,
    };
    const clock = { now: () => new Date("2030-04-02T00:00:00Z") };
    const input = (day: number) => ({
      unitId: units[0],
      startsAt: `2030-04-${day.toString().padStart(2, "0")}T10:00:00.000Z`,
      endsAt: `2030-04-${day.toString().padStart(2, "0")}T11:00:00.000Z`,
    });
    const booking = await createReservation(
      source.domain,
      actor,
      tenants[0],
      "before-backup",
      input(3),
      randomUUID(),
      3600,
      clock,
    );
    const expected = await snapshot(source.administration);
    const backup = await createBackup(
      source.administration.options.connectionString as string,
      path.join(source.root, "recovery.dump"),
      process.env.PG_BIN as string,
    );
    const later = await createReservation(
      source.domain,
      actor,
      tenants[0],
      "after-backup",
      input(10),
      randomUUID(),
      3600,
      clock,
    );
    await withDatabase(async (destination) => {
      await destination.administration.query("CREATE DATABASE quenda_recovery");
      const connection = (pool: Pool) => {
        const u = new URL(pool.options.connectionString as string);
        u.pathname = "/quenda_recovery";
        return u;
      };
      const adminUrl = connection(destination.administration),
        password = decodeURIComponent(adminUrl.password);
      adminUrl.password = "";
      const started = performance.now();
      await execute(
        path.join(process.env.PG_BIN as string, "pg_restore"),
        [
          "--no-password",
          "--exit-on-error",
          "--single-transaction",
          "--dbname",
          adminUrl.toString(),
          backup.path,
        ],
        { env: { ...process.env, PGPASSWORD: password } },
      );
      const restoreMs = performance.now() - started;
      adminUrl.password = password;
      const admin = new Pool({ connectionString: adminUrl.toString() });
      const domain = new Pool({
        connectionString: connection(destination.domain).toString(),
      });
      const migration = new Client({
        connectionString: connection(destination.migration).toString(),
      });
      try {
        assert.deepEqual(await snapshot(admin), expected);
        await assertRuntimeRole(domain);
        const replay = await createReservation(
          domain,
          actor,
          tenants[0],
          "before-backup",
          input(3),
          randomUUID(),
          3600,
          clock,
        );
        assert.equal(replay.replayed, true);
        assert.deepEqual(replay.result, booking.result);
        assert.deepEqual(await snapshot(admin), expected);

        await migration.connect();
        assert.deepEqual(
          await migrate(migration, path.resolve("db/migrations")),
          [],
        );
        assert.equal(
          (
            await readReservation(
              domain,
              actor,
              tenants[0],
              booking.result.id,
              clock,
            )
          ).status,
          "CONFIRMADA",
        );
        await assert.rejects(
          readReservation(domain, actor, tenants[1], booking.result.id, clock),
          { code: "NOT_FOUND" },
        );
        await assert.rejects(
          readReservation(domain, actor, tenants[0], later.result.id, clock),
          { code: "NOT_FOUND" },
        );
        await assert.rejects(domain.query('SELECT * FROM auth."user"'), {
          code: "42501",
        });
        await admin.query("SELECT domain.assert_agreement_consumption($1,$2)", [
          tenants[0],
          booking.result.id,
        ]);
        const wrongUrl = connection(destination.auth);
        wrongUrl.password = new URL(
          source.auth.options.connectionString as string,
        ).password;
        const wrong = new Client({ connectionString: wrongUrl.toString() });
        try {
          await assert.rejects(wrong.connect(), { code: "28P01" });
        } finally {
          await wrong.end();
        }
        await cancelReservation(
          domain,
          actor,
          tenants[0],
          booking.result.id,
          "cancel-restored",
          { expectedRevision: 1 },
          randomUUID(),
          3600,
          clock,
        );
        assert.equal(
          (
            await admin.query(
              "SELECT released FROM domain.agreement_consumption WHERE reservation_id=$1",
              [booking.result.id],
            )
          ).rows[0].released,
          true,
        );
        assert.equal(
          (
            await admin.query(
              "SELECT count(*)::int AS n FROM domain.occupancy WHERE reservation_id=$1 AND released_at IS NULL",
              [booking.result.id],
            )
          ).rows[0].n,
          0,
        );
        assert.equal(
          (
            await readReservation(
              source.domain,
              actor,
              tenants[0],
              booking.result.id,
              clock,
            )
          ).status,
          "CONFIRMADA",
        );
        t.diagnostic(
          JSON.stringify({
            backupMs: backup.durationMs,
            restoreMs,
            reconciliationMs: performance.now() - started - restoreMs,
            reservationsRecovered: 1,
            postSnapshotReservationsNotRecovered: 1,
          }),
        );
      } finally {
        await migration.end();
        await Promise.all([admin.end(), domain.end()]);
      }
    });
  });
});
