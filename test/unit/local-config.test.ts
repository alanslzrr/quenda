import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);
test("local setup separates secrets, limits file access and refuses overwrites", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "quenda-env-"));
  const script = path.resolve("scripts/local-config.ts");
  try {
    const { stdout } = await execute(process.execPath, [script], {
      cwd: directory,
    });
    const runtime = await readFile(path.join(directory, ".env.local"), "utf8");
    const migration = await readFile(
      path.join(directory, ".env.migration.local"),
      "utf8",
    );
    assert.ok(!runtime.includes("MIGRATION") && !runtime.includes("BOOTSTRAP"));
    assert.ok(!migration.includes("DOMAIN_DATABASE_URL"));
    for (const name of [
      ".env.local",
      ".env.migration.local",
      ".env.bootstrap.local",
    ]) {
      assert.equal(
        (await stat(path.join(directory, name))).mode & 0o777,
        0o600,
      );
    }
    assert.ok(!stdout.includes("postgresql://"));
    await assert.rejects(
      execute(process.execPath, [script], { cwd: directory }),
    );
    assert.equal(
      await readFile(path.join(directory, ".env.local"), "utf8"),
      runtime,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
