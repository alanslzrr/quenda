import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { sourceArchive } from "../../scripts/lib/source-archive.ts";

const execute = promisify(execFile);

test("source archive is revision-bound, complete, repeatable and refuses dirty or sensitive trees", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "quenda-source-test-"));
  const repository = path.join(root, "repo");
  await mkdir(repository);
  const git = (...args: string[]) =>
    execute("git", args, {
      cwd: repository,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    });
  const commit = async () => {
    await git("add", ".");
    await git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "Fixture",
    );
  };
  try {
    await git("init");
    for (const [file, content] of Object.entries({
      LICENSE: "AGPL test fixture",
      "package.json": JSON.stringify({ license: "AGPL-3.0-only" }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'",
      Dockerfile: "FROM scratch",
      ".gitignore": ".local/\n",
      "main.ts": "export const fixture = true;",
    }))
      await writeFile(path.join(repository, file), content);
    await commit();
    await mkdir(path.join(repository, ".local"));
    await writeFile(
      path.join(repository, ".local", "secret"),
      "not for distribution",
    );
    const destination = path.join(root, "source.tar.gz");
    const result = await sourceArchive(repository, destination);
    assert.equal(
      result.revision,
      (await git("rev-parse", "HEAD")).stdout.trim(),
    );
    assert.equal(
      result.sha256,
      createHash("sha256")
        .update(await readFile(destination))
        .digest("hex"),
    );
    const entries = (await execute("tar", ["-tzf", destination])).stdout;
    assert.ok(entries.includes(`quenda-${result.revision}/main.ts`));
    assert.ok(entries.includes("pnpm-lock.yaml"));
    assert.ok(!entries.includes(".local"));
    assert.ok(!entries.includes(".git/"));
    assert.equal(
      (await sourceArchive(repository, path.join(root, "second.tar.gz")))
        .sha256,
      result.sha256,
    );
    await assert.rejects(sourceArchive(repository, destination), {
      code: "EEXIST",
    });
    await writeFile(path.join(repository, "main.ts"), "pending change");
    await assert.rejects(
      sourceArchive(repository, path.join(root, "dirty.tar.gz")),
      /pending changes/,
    );
    await commit();
    await writeFile(path.join(repository, ".env.local"), "SECRET=fixture");
    await commit();
    await assert.rejects(
      sourceArchive(repository, path.join(root, "secret.tar.gz")),
      /restricted tracked/,
    );
    await git("rm", ".env.local");
    await commit();
    await writeFile(
      path.join(repository, ".git", "info", "attributes"),
      "main.ts export-ignore\n",
    );
    await assert.rejects(
      sourceArchive(repository, path.join(root, "attributes.tar.gz")),
      /archive attributes/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
