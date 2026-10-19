import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Client, Pool } from "pg";
import { bootstrap } from "../../scripts/lib/bootstrap.ts";
import { migrate } from "../../scripts/lib/migrations.ts";

const execute = promisify(execFile);
export async function freePort(): Promise<number> {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

export async function withDatabase<T>(
  run: (context: {
    root: string;
    domain: Pool;
    auth: Pool;
    migration: Pool;
  }) => Promise<T>,
): Promise<T> {
  const bin = process.env.PG_BIN;
  assert.ok(
    bin,
    "PG_BIN must point to PostgreSQL 17.11; integration tests do not skip",
  );
  assert.match(
    (await execute(path.join(bin, "postgres"), ["--version"])).stdout,
    /PostgreSQL\) 17\.11\b/,
  );
  const root = await mkdtemp(path.join(os.tmpdir(), "quenda-pg-"));
  const data = path.join(root, "data");
  const passwordFile = path.join(root, "password");
  const password = () => randomBytes(24).toString("hex");
  const adminPassword = password();
  const passwords = {
    migration: password(),
    domain: password(),
    auth: password(),
  };
  const port = await freePort();
  const url = (role: string, secret: string, db = "quenda") =>
    `postgresql://${role}:${secret}@127.0.0.1:${port}/${db}`;
  const pools: Pool[] = [];
  const clients: Client[] = [];
  let started = false;
  const connect = async (connectionString: string) => {
    const client = new Client({ connectionString });
    clients.push(client);
    await client.connect();
    return client;
  };
  const pool = (role: string, secret: string) => {
    const instance = new Pool({ connectionString: url(role, secret), max: 5 });
    pools.push(instance);
    return instance;
  };
  try {
    await writeFile(passwordFile, adminPassword, { mode: 0o600 });
    await execute(path.join(bin, "initdb"), [
      "-D",
      data,
      "-U",
      "quenda_bootstrap",
      "-A",
      "scram-sha-256",
      "--pwfile",
      passwordFile,
      "--no-locale",
      "--encoding=UTF8",
    ]);
    await rm(passwordFile);
    await execute(path.join(bin, "pg_ctl"), [
      "-D",
      data,
      "-l",
      path.join(root, "postgres.log"),
      "-o",
      `-h 127.0.0.1 -p ${port} -k '${root}'`,
      "-w",
      "start",
    ]);
    started = true;
    const initial = await connect(
      url("quenda_bootstrap", adminPassword, "postgres"),
    );
    await initial.query("CREATE DATABASE quenda");
    const admin = await connect(url("quenda_bootstrap", adminPassword));
    await bootstrap(admin, passwords);
    const owner = await connect(url("quenda_migrator", passwords.migration));
    await migrate(owner, path.resolve("db/migrations"));
    return await run({
      root,
      domain: pool("quenda_domain", passwords.domain),
      auth: pool("quenda_auth", passwords.auth),
      migration: pool("quenda_migrator", passwords.migration),
    });
  } finally {
    await Promise.all(pools.map((pool) => pool.end()));
    await Promise.all(clients.map((client) => client.end()));
    if (started)
      await execute(path.join(bin, "pg_ctl"), [
        "-D",
        data,
        "-m",
        "immediate",
        "-w",
        "stop",
      ]);
    await rm(root, { recursive: true, force: true });
  }
}
