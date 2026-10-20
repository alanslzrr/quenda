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
import { initialAcceptance } from "../helpers/usage-rules-fixture.ts";

const execute = promisify(execFile);
const snapshot = async (pool: Pool) => {
  const tables = (
    await pool.query<{ schema_name: string; table_name: string }>(
      `SELECT schemaname AS schema_name,tablename AS table_name FROM pg_catalog.pg_tables
     WHERE schemaname IN ('auth','domain','quenda_meta') ORDER BY schemaname,tablename`,
    )
  ).rows;
  const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
  return Object.fromEntries(
    await Promise.all(
      tables.map(async ({ schema_name, table_name }) => {
        const table = `${quote(schema_name)}.${quote(table_name)}`;
        return [
          table,
          (
            await pool.query(
              `SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`,
            )
          ).rows,
        ];
      }),
    ),
  );
};

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
      {
        acceptance: initialAcceptance,
        ...input(3),
      },
      randomUUID(),
      3600,
      clock,
    );
    // Non-empty fixtures for the latest audit tables guard against silently
    // omitting newly added data from the restore comparison.
    await source.migration.query(
      "UPDATE domain.municipality SET booking_policy_version=2,advance_days=20 WHERE id=$1",
      [tenants[0]],
    );
    await source.migration.query(
      `INSERT INTO domain.municipal_booking_policy_event(tenant_id,actor_id,version,previous_advance_days,advance_days,previous_cancellation_minutes,cancellation_minutes,reason,correlation_id)
      VALUES($1,'citizen',2,30,20,0,0,'Recovery fixture',$2)`,
      [tenants[0], randomUUID()],
    );
    await source.migration.query(
      "INSERT INTO domain.reservation_read_event(tenant_id,reservation_id,actor_id,operation,correlation_id) VALUES($1,$2,'citizen','DETAIL',$3)",
      [tenants[0], booking.result.id, randomUUID()],
    );
    const expected = await snapshot(source.administration);
    assert.equal(
      expected['"domain"."municipal_booking_policy_event"']?.length,
      1,
    );
    assert.equal(expected['"domain"."reservation_read_event"']?.length, 1);
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
      {
        acceptance: {
          usageRulesVersion: 1,
          bookingPolicyVersion: 2,
          nonCancellable: false,
        },
        ...input(10),
      },
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
          {
            acceptance: initialAcceptance,
            ...input(3),
          },
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
