import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { Client } from "pg";
import { createBackup } from "../../scripts/lib/backup.ts";
import { withDatabase } from "../helpers/postgres.ts";

const execute = promisify(execFile);
test("restore CLI verifies checksum and creates only new databases closed to runtime roles", {
  timeout: 60000,
}, async () => {
  await withDatabase(async ({ root, administration, domain }) => {
    const source = administration.options.connectionString as string;
    const backup = await createBackup(
      source,
      path.join(root, "restore.dump"),
      process.env.PG_BIN as string,
    );
    const restore = (hash: string, database: string, archive = backup.path) =>
      execute(
        process.execPath,
        ["scripts/restore.ts", archive, hash, database],
        {
          env: { ...process.env, RESTORE_ADMIN_DATABASE_URL: source },
          timeout: 30000,
        },
      );
    await assert.rejects(restore("0".repeat(64), "bad_checksum"));
    assert.equal(
      (
        await administration.query(
          "SELECT 1 FROM pg_database WHERE datname='bad_checksum'",
        )
      ).rowCount,
      0,
    );
    await administration.query("GRANT quenda_auth TO quenda_domain");
    await assert.rejects(restore(backup.sha256, "unsafe_roles"));
    assert.equal(
      (
        await administration.query(
          "SELECT 1 FROM pg_database WHERE datname='unsafe_roles'",
        )
      ).rowCount,
      0,
    );
    await administration.query("REVOKE quenda_auth FROM quenda_domain");
    const broken = path.join(root, "broken.dump");
    await writeFile(broken, "invalid archive", { mode: 0o600 });
    await assert.rejects(
      restore(
        createHash("sha256").update("invalid archive").digest("hex"),
        "failed_closed",
        broken,
      ),
    );
    assert.deepEqual(
      (
        await administration.query(
          "SELECT datconnlimit, has_database_privilege('quenda_domain',datname,'CONNECT') AS allowed FROM pg_database WHERE datname='failed_closed'",
        )
      ).rows,
      [{ datconnlimit: 0, allowed: false }],
    );
    await assert.rejects(restore(backup.sha256, "quenda"));
    const result = JSON.parse(
      (await restore(backup.sha256, "recovered_closed")).stdout,
    );
    assert.equal(result.status, "RESTORED_CLOSED");
    assert.equal(result.sha256, backup.sha256);
    assert.equal(
      (
        await administration.query(
          "SELECT datconnlimit FROM pg_database WHERE datname='recovered_closed'",
        )
      ).rows[0].datconnlimit,
      0,
    );
    assert.equal(
      (
        await administration.query(
          "SELECT has_database_privilege('quenda_domain','recovered_closed','CONNECT') AS allowed",
        )
      ).rows[0].allowed,
      false,
    );
    const target = new URL(source);
    target.pathname = "/recovered_closed";
    const admin = new Client({ connectionString: target.toString() });
    try {
      await admin.connect();
      const before = (
        await admin.query(
          "SELECT filename,sha256 FROM quenda_meta.migrations ORDER BY filename",
        )
      ).rows;
      assert.ok(before.length > 0);
      await assert.rejects(restore(backup.sha256, "recovered_closed"));
      assert.deepEqual(
        (
          await admin.query(
            "SELECT filename,sha256 FROM quenda_meta.migrations ORDER BY filename",
          )
        ).rows,
        before,
      );
      const runtimeUrl = new URL(domain.options.connectionString as string);
      runtimeUrl.pathname = "/recovered_closed";
      const runtime = new Client({ connectionString: runtimeUrl.toString() });
      try {
        await assert.rejects(runtime.connect(), { code: "42501" });
      } finally {
        await runtime.end();
      }
    } finally {
      await admin.end();
    }
  });
});
