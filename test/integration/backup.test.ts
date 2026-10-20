import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { Client } from "pg";
import { withDatabase } from "../helpers/postgres.ts";

const execute = promisify(execFile);
test("backup CLI publishes a private restore archive without overwrite or partial output", {
  timeout: 60000,
}, async () => {
  await withDatabase(async ({ root, administration, domain }) => {
    const account = randomUUID();
    await administration.query(
      'INSERT INTO auth."user"(id,name,email,"emailVerified") VALUES($1,\'Synthetic\',$2,true)',
      [account, `${account}@example.test`],
    );
    const destination = path.join(root, "backup.dump");
    const invoke = (url: string, file: string) =>
      execute(process.execPath, ["scripts/backup.ts", file], {
        env: { ...process.env, BACKUP_DATABASE_URL: url },
        timeout: 30000,
      });
    const source = administration.options.connectionString;
    assert.ok(source);
    const result = await invoke(source, destination);
    const receipt = JSON.parse(result.stdout);
    const bytes = await readFile(destination);
    assert.equal(bytes.subarray(0, 5).toString(), "PGDMP");
    assert.equal(
      receipt.sha256,
      createHash("sha256").update(bytes).digest("hex"),
    );
    assert.ok(receipt.durationMs > 0);
    assert.equal((await stat(destination)).mode & 0o777, 0o600);
    assert.ok(!result.stdout.includes(new URL(source).password));
    const listed = await execute(
      path.join(process.env.PG_BIN as string, "pg_restore"),
      ["--list", destination],
    );
    assert.match(listed.stdout, /TABLE DATA auth user/);
    assert.match(listed.stdout, /TABLE DATA quenda_meta migrations/);
    assert.match(listed.stdout, /POLICY domain/);
    await administration.query("CREATE DATABASE quenda_restore");
    const restoredUrl = new URL(source);
    restoredUrl.pathname = "/quenda_restore";
    const restorePassword = decodeURIComponent(restoredUrl.password);
    restoredUrl.password = "";
    await execute(
      path.join(process.env.PG_BIN as string, "pg_restore"),
      [
        "--exit-on-error",
        "--single-transaction",
        "--no-password",
        "--dbname",
        restoredUrl.toString(),
        destination,
      ],
      { env: { ...process.env, PGPASSWORD: restorePassword } },
    );
    restoredUrl.password = restorePassword;
    const restored = new Client({ connectionString: restoredUrl.toString() });
    try {
      await restored.connect();
      assert.equal(
        (
          await restored.query('SELECT id FROM auth."user" WHERE id=$1', [
            account,
          ])
        ).rows[0].id,
        account,
      );
      assert.deepEqual(
        (
          await restored.query(
            "SELECT filename,sha256 FROM quenda_meta.migrations ORDER BY filename",
          )
        ).rows,
        (
          await administration.query(
            "SELECT filename,sha256 FROM quenda_meta.migrations ORDER BY filename",
          )
        ).rows,
      );
      assert.equal(
        (
          await restored.query(
            "SELECT relforcerowsecurity FROM pg_class WHERE oid='domain.reservation'::regclass",
          )
        ).rows[0].relforcerowsecurity,
        true,
      );
      assert.equal(
        (
          await restored.query(
            "SELECT has_table_privilege('quenda_domain','auth.user','SELECT') AS allowed",
          )
        ).rows[0].allowed,
        false,
      );
    } finally {
      await restored.end();
    }

    await assert.rejects(invoke(source, destination));
    assert.deepEqual(await readFile(destination), bytes);
    const occupied = path.join(root, "occupied.dump");
    await writeFile(occupied, "keep");
    await assert.rejects(invoke(source, occupied));
    assert.equal(await readFile(occupied, "utf8"), "keep");
    const failed = path.join(root, "failed.dump");
    await assert.rejects(
      invoke(domain.options.connectionString as string, failed),
      (error: unknown) => {
        const failure = error as {
          code: number;
          stdout: string;
          stderr: string;
        };
        assert.equal(failure.code, 1);
        assert.equal(failure.stdout, "");
        assert.ok(!failure.stderr.includes("postgresql://"));
        return true;
      },
    );
    await assert.rejects(stat(failed), { code: "ENOENT" });
    assert.ok(
      !(await readdir(root)).some((name) => name.startsWith(".quenda-backup-")),
    );
  });
});
