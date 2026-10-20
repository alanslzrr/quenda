import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { Client } from "pg";
import { postgresCommandConnection } from "./postgres-connection.ts";

const execute = promisify(execFile);
export async function restoreBackup(
  connection: string,
  archive: string,
  sha256: string,
  database: string,
  bin: string,
) {
  if (
    !/^[a-z][a-z0-9_]{0,62}$/.test(database) ||
    ["postgres", "template0", "template1"].includes(database) ||
    !/^[a-f0-9]{64}$/.test(sha256)
  )
    throw new Error("Invalid restore arguments");
  const { url, password } = postgresCommandConnection(connection);
  if (decodeURIComponent(url.pathname.slice(1)) === database)
    throw new Error("Restore requires a new database");
  const executable = path.join(bin, "pg_restore");
  if (
    !/PostgreSQL\) 17\./.test((await execute(executable, ["--version"])).stdout)
  )
    throw new Error("PostgreSQL 17 client required");
  const staging = await mkdtemp(path.join(os.tmpdir(), "quenda-restore-"));
  const file = path.join(staging, "trusted.dump");
  const admin = new Client({ connectionString: connection });
  const started = performance.now();
  try {
    await pipeline(
      createReadStream(archive),
      createWriteStream(file, { flags: "wx", mode: 0o600 }),
    );
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    if (hash.digest("hex") !== sha256)
      throw new Error("Backup checksum mismatch");
    await admin.connect();
    const roles = await admin.query(
      "SELECT rolname FROM pg_roles r WHERE rolname=ANY($1::text[]) AND rolcanlogin AND NOT (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication) AND NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid)",
      [["quenda_migrator", "quenda_domain", "quenda_auth", "quenda_worker"]],
    );
    if (roles.rowCount !== 4)
      throw new Error("Provision safe destination roles first");
    // CREATE fails if the name already exists. No DROP/CLEAN is ever issued.
    // CONNECTION LIMIT 0 closes the creation-to-REVOKE window for non-superusers.
    await admin.query(
      `CREATE DATABASE "${database}" TEMPLATE template0 CONNECTION LIMIT 0`,
    );
    await admin.query(`REVOKE ALL ON DATABASE "${database}" FROM PUBLIC`);
    url.pathname = `/${database}`;
    const result = await execute(
      executable,
      [
        "--exit-on-error",
        "--single-transaction",
        "--no-password",
        "--dbname",
        url.toString(),
        file,
      ],
      {
        env: { ...process.env, PGPASSWORD: password, PGCONNECT_TIMEOUT: "10" },
        maxBuffer: 1024 * 1024,
      },
    );
    if (result.stderr.trim())
      throw new Error("Restore diagnostics require review");
    // Keep an application-level privacy gate even if a DBA subsequently changes
    // CONNECT or the database connection limit during recovery checks.
    const destination = new Client({
      connectionString: (() => {
        const value = new URL(connection);
        value.pathname = `/${database}`;
        return value.toString();
      })(),
    });
    try {
      await destination.connect();
      await destination.query(
        "UPDATE domain.retention_control SET restore_review_required=true,privacy_replayed_at=NULL,privacy_checkpoint_sha256=NULL WHERE id",
      );
    } finally {
      await destination.end();
    }
    return {
      database,
      sha256,
      status: "RESTORED_CLOSED" as const,
      durationMs: performance.now() - started,
    };
  } finally {
    await admin.end();
    await rm(staging, { recursive: true, force: true });
  }
}
