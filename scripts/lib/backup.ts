import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, link, mkdtemp, open, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
export async function createBackup(
  connection: string,
  destination: string,
  bin: string,
) {
  const url = new URL(connection);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.hostname ||
    !url.pathname.slice(1)
  )
    throw new Error("Invalid backup connection");
  for (const key of url.searchParams.keys())
    if (
      ![
        "sslmode",
        "sslrootcert",
        "sslcert",
        "sslkey",
        "connect_timeout",
      ].includes(key)
    )
      throw new Error("Unsupported backup connection option");
  const password = decodeURIComponent(url.password);
  url.password = "";
  const executable = path.join(bin, "pg_dump");
  const version = await execute(executable, ["--version"]);
  if (!/PostgreSQL\) 17\./.test(version.stdout))
    throw new Error("PostgreSQL 17 client required");
  const output = path.resolve(destination);
  try {
    await access(output);
    throw new Error("Backup destination exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const staging = await mkdtemp(
    path.join(path.dirname(output), ".quenda-backup-"),
  );
  const temporary = path.join(staging, "database.dump");
  const started = performance.now();
  try {
    const file = await open(temporary, "wx", 0o600);
    await file.close();
    // The password is not placed in process arguments or emitted diagnostics.
    // RLS stays disabled: a role unable to dump all rows must fail, not filter.
    const dump = await execute(
      executable,
      [
        "--format=custom",
        "--no-password",
        "--dbname",
        url.toString(),
        "--file",
        temporary,
      ],
      {
        env: { ...process.env, PGPASSWORD: password, PGCONNECT_TIMEOUT: "10" },
        maxBuffer: 1024 * 1024,
      },
    );
    if (dump.stderr.trim())
      throw new Error("Backup diagnostics require review");
    const handle = await open(temporary, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(temporary)) hash.update(chunk);
    // Same-filesystem link publishes without replacing an existing destination.
    await link(temporary, output);
    return {
      path: output,
      sha256: hash.digest("hex"),
      durationMs: performance.now() - started,
    };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
