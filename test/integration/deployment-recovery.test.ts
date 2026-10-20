import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { Client } from "pg";
import { migrate } from "../../scripts/lib/migrations.ts";
import {
  cancelReservation,
  createReservation,
  readReservation,
} from "../../src/modules/reservations/index.ts";
import { withDatabase } from "../helpers/postgres.ts";
import { recoveryFixture } from "../helpers/recovery-fixture.ts";
import { initialAcceptance } from "../helpers/usage-rules-fixture.ts";

test("failed release retains its committed migration prefix and recovers forward without losing bookings", {
  timeout: 60000,
}, async (t) => {
  await withDatabase(
    async ({ root, auth, domain, migration, administration }) => {
      const { tenants, units } = await recoveryFixture(auth, migration);
      const actor = {
        accountId: "citizen",
        email: "citizen@example.test",
        sessionId: "fixture",
        mfaVerifiedAt: null,
      };
      const clock = { now: () => new Date("2030-04-02T00:00:00Z") };
      const booking = await createReservation(
        domain,
        actor,
        tenants[0],
        "before-release",
        {
          acceptance: initialAcceptance,
          unitId: units[0],
          startsAt: "2030-04-03T10:00:00.000Z",
          endsAt: "2030-04-03T11:00:00.000Z",
        },
        randomUUID(),
        3600,
        clock,
      );
      const snapshot = async () => {
        const result: Record<string, unknown> = {};
        for (const table of [
          "reservation",
          "occupancy",
          "reservation_event",
          "reservation_notice",
          "reservation_email",
          "agreement_consumption",
          "agreement_consumption_event",
        ]) {
          result[table] = (
            await administration.query(
              `SELECT to_jsonb(t) AS row FROM domain.${table} t ORDER BY to_jsonb(t)::text`,
            )
          ).rows;
        }
        return result;
      };
      const before = await snapshot();
      const history = (
        await administration.query(
          "SELECT filename,sha256 FROM quenda_meta.migrations ORDER BY filename",
        )
      ).rows;
      const release = path.join(root, "release");
      await cp(path.resolve("db/migrations"), release, { recursive: true });
      // Test-only additive migration: the previous application remains compatible.
      await writeFile(
        path.join(release, "9000_release_probe.sql"),
        "CREATE TABLE quenda_meta.release_probe (id integer PRIMARY KEY); INSERT INTO quenda_meta.release_probe VALUES(1);",
      );
      const failed = path.join(release, "9001_release_failure.sql");
      await writeFile(
        failed,
        "INSERT INTO quenda_meta.release_probe VALUES(2); CREATE TABLE quenda_meta.partial_release (id integer); SELECT 1/0;",
      );
      const client = new Client({
        connectionString: migration.options.connectionString,
      });
      await client.connect();
      const started = performance.now();
      try {
        await assert.rejects(migrate(client, release), { code: "22012" });
        assert.deepEqual(
          (
            await client.query(
              "SELECT id FROM quenda_meta.release_probe ORDER BY id",
            )
          ).rows,
          [{ id: 1 }],
        );
        assert.equal(
          (
            await client.query(
              "SELECT to_regclass('quenda_meta.partial_release') AS name",
            )
          ).rows[0].name,
          null,
        );
        const after = (
          await client.query(
            "SELECT filename,sha256 FROM quenda_meta.migrations ORDER BY filename",
          )
        ).rows;
        assert.deepEqual(after.slice(0, history.length), history);
        assert.deepEqual(
          after.slice(history.length).map((row) => row.filename),
          ["9000_release_probe.sql"],
        );
        assert.deepEqual(await snapshot(), before);
        // A migration failure must release its session lock, not strand the next release.
        const other = new Client({
          connectionString: migration.options.connectionString,
        });
        await other.connect();
        try {
          assert.equal(
            (
              await other.query(
                "SELECT pg_try_advisory_lock(hashtext('quenda:migrations')) AS acquired",
              )
            ).rows[0].acquired,
            true,
          );
          await other.query(
            "SELECT pg_advisory_unlock(hashtext('quenda:migrations'))",
          );
        } finally {
          await other.end();
        }
        // An old migration bundle cannot erase the prefix that already committed.
        await assert.rejects(
          migrate(client, path.resolve("db/migrations")),
          /must not be removed/,
        );
        const readable = await readReservation(
          domain,
          actor,
          tenants[0],
          booking.result.id,
        );
        assert.equal(readable.status, "CONFIRMADA");
        // Only the unapplied migration is corrected; committed migration hashes stay intact.
        await writeFile(
          failed,
          "INSERT INTO quenda_meta.release_probe VALUES(2);",
        );
        assert.deepEqual(await migrate(client, release), [
          "9001_release_failure.sql",
        ]);
        assert.deepEqual(await migrate(client, release), []);
        assert.deepEqual(
          (
            await client.query(
              "SELECT id FROM quenda_meta.release_probe ORDER BY id",
            )
          ).rows,
          [{ id: 1 }, { id: 2 }],
        );
        assert.deepEqual(await snapshot(), before);
        await cancelReservation(
          domain,
          actor,
          tenants[0],
          booking.result.id,
          "after-release",
          { expectedRevision: 1 },
          randomUUID(),
          3600,
          clock,
        );
        assert.equal(
          (await readReservation(domain, actor, tenants[0], booking.result.id))
            .status,
          "CANCELADA",
        );
        assert.equal(
          (
            await administration.query(
              "SELECT released FROM domain.agreement_consumption WHERE reservation_id=$1",
              [booking.result.id],
            )
          ).rows[0].released,
          true,
        );
        assert.equal(
          (
            await administration.query(
              "SELECT count(*)::int AS n FROM domain.occupancy WHERE reservation_id=$1 AND released_at IS NULL",
              [booking.result.id],
            )
          ).rows[0].n,
          0,
        );
        t.diagnostic(
          JSON.stringify({
            recoveryMs: performance.now() - started,
            recoveredReservations: 1,
            lostReservations: 0,
          }),
        );
      } finally {
        await client.end();
      }
    },
  );
});
