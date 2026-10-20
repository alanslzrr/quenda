import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { Client } from "pg";
import { createBackup } from "../../scripts/lib/backup.ts";
import { restoreBackup } from "../../scripts/lib/restore.ts";
import { createReservation } from "../../src/modules/reservations/index.ts";
import { withDatabase } from "../helpers/postgres.ts";
import { recoveryFixture } from "../helpers/recovery-fixture.ts";

const execute = promisify(execFile);
test("restored database reconciliation is read-only, detects inconsistent occupancy and keeps mail closed", {
  timeout: 60000,
}, async () => {
  await withDatabase(
    async ({ root, auth, migration, domain, administration }) => {
      const { tenants, units } = await recoveryFixture(auth, migration);
      await createReservation(
        domain,
        {
          accountId: "citizen",
          email: "citizen@example.test",
          sessionId: "fixture",
          mfaVerifiedAt: null,
        },
        tenants[0],
        "reconcile-booking",
        {
          unitId: units[0],
          startsAt: "2030-04-03T10:00:00Z",
          endsAt: "2030-04-03T11:00:00Z",
        },
        randomUUID(),
        3600,
        { now: () => new Date("2030-04-02T00:00:00Z") },
      );
      const block = randomUUID();
      const setup = await administration.connect();
      try {
        await setup.query("BEGIN");
        await setup.query(
          "INSERT INTO domain.schedule_block(tenant_id,id,unit_id,starts_at,ends_at,actor_id,reason) VALUES($1,$2,$3,'2030-04-04T10:00:00Z','2030-04-04T11:00:00Z','citizen','Synthetic recovery block')",
          [tenants[0], block, units[0]],
        );
        await setup.query(
          "INSERT INTO domain.occupancy(tenant_id,id,unit_id,block_id,period) VALUES($1,$2,$3,$4,'[2030-04-04T10:00:00Z,2030-04-04T11:00:00Z)')",
          [tenants[0], randomUUID(), units[0], block],
        );
        await setup.query("COMMIT");
      } finally {
        setup.release();
      }
      const source = administration.options.connectionString as string;
      const bin = process.env.PG_BIN as string;
      const backup = await createBackup(
        source,
        path.join(root, "reconcile.dump"),
        bin,
      );
      await restoreBackup(
        source,
        backup.path,
        backup.sha256,
        "reconcile_closed",
        bin,
      );
      const url = new URL(source);
      url.pathname = "/reconcile_closed";
      const run = (connection = url.toString()) =>
        execute(process.execPath, ["scripts/reconcile.ts"], {
          env: { ...process.env, RESTORE_ADMIN_DATABASE_URL: connection },
          timeout: 30000,
        });
      const admin = new Client({ connectionString: url.toString() });
      await admin.connect();
      try {
        const snapshot = async () =>
          (
            await admin.query(
              "SELECT to_jsonb(q) AS row FROM domain.reservation_email q ORDER BY event_id",
            )
          ).rows;
        const before = await snapshot();
        const report = JSON.parse((await run()).stdout);
        assert.equal(report.status, "CHECKED_REQUIRES_REVIEW");
        assert.equal(report.reopeningAuthorized, false);
        assert.equal(report.connectionLimit, 0);
        assert.ok(Object.values(report.checks).every((n) => n === 0));
        assert.equal(report.mail.pending, 1);
        assert.equal(report.mail.accepted, 0);
        assert.deepEqual(await snapshot(), before);
        assert.ok(!JSON.stringify(report).includes("citizen"));
        // Controlled corruption in the disposable restored database only.
        await admin.query("BEGIN");
        await admin.query("SET LOCAL session_replication_role=replica");
        await admin.query("DELETE FROM domain.occupancy");
        await admin.query(
          "UPDATE domain.agreement_consumption SET week_start=week_start+1",
        );
        await admin.query(
          "UPDATE domain.reservation_event SET kind='CANCELADA'",
        );
        await admin.query(
          "UPDATE quenda_meta.migrations SET sha256=repeat('0',64) WHERE filename=(SELECT min(filename) FROM quenda_meta.migrations)",
        );
        await admin.query("COMMIT");
        await assert.rejects(run(), (error: unknown) => {
          const failure = error as { code: number; stdout: string };
          assert.equal(failure.code, 2);
          const broken = JSON.parse(failure.stdout);
          assert.equal(broken.status, "INCONSISTENT");
          assert.equal(broken.checks.reservationOccupancy, 1);
          assert.equal(broken.checks.blockOccupancy, 1);
          assert.equal(broken.checks.consumptionConsistency, 1);
          assert.equal(broken.checks.reservationEvents, 1);
          assert.equal(broken.checks.migrationHistory, 1);
          assert.equal(broken.reopeningAuthorized, false);
          return true;
        });
        assert.deepEqual(await snapshot(), before);
        assert.equal(
          (
            await admin.query(
              "SELECT datconnlimit FROM pg_database WHERE datname=current_database()",
            )
          ).rows[0].datconnlimit,
          0,
        );
        await assert.rejects(
          run(domain.options.connectionString as string),
          (error: unknown) => {
            const failure = error as {
              code: number;
              stdout: string;
              stderr: string;
            };
            assert.equal(failure.code, 1);
            assert.equal(failure.stdout, "");
            assert.ok(!failure.stderr.includes("citizen"));
            return true;
          },
        );
      } finally {
        await admin.end();
      }
    },
  );
});
