import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { Client, Pool } from "pg";
import { bootstrap } from "../../scripts/lib/bootstrap.ts";
import { migrate } from "../../scripts/lib/migrations.ts";
import { assertRuntimeRole } from "../../src/database/pools.ts";
import { transaction } from "../../src/database/transaction.ts";

const execute = promisify(execFile);
async function freePort(): Promise<number> {
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

test("isolated PostgreSQL: bootstrap, migrations, role separation, transactions and shutdown", {
  timeout: 90000,
}, async (t) => {
  const bin = process.env.PG_BIN;
  assert.ok(
    bin,
    "Set PG_BIN to the PostgreSQL 17.11 bin directory; integration tests never silently skip",
  );
  const version = await execute(path.join(bin, "postgres"), ["--version"]);
  assert.match(version.stdout, /PostgreSQL\) 17\.11\b/);
  const root = await mkdtemp(path.join(os.tmpdir(), "quenda-pg-"));
  const data = path.join(root, "data");
  const passwordFile = path.join(root, "password");
  const adminPassword = randomBytes(24).toString("hex");
  const passwords = {
    migration: randomBytes(24).toString("hex"),
    domain: randomBytes(24).toString("hex"),
    auth: randomBytes(24).toString("hex"),
  };
  const port = await freePort();
  const url = (role: string, password: string, db = "quenda") =>
    `postgresql://${role}:${password}@127.0.0.1:${port}/${db}`;
  let started = false;
  const pools: Pool[] = [];
  const clients: Client[] = [];
  const connect = async (connectionString: string) => {
    const client = new Client({ connectionString });
    clients.push(client);
    await client.connect();
    return client;
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
    const migration = await connect(
      url("quenda_migrator", passwords.migration),
    );
    const domain = new Pool({
      connectionString: url("quenda_domain", passwords.domain),
      max: 1,
    });
    const auth = new Pool({
      connectionString: url("quenda_auth", passwords.auth),
      max: 1,
    });
    pools.push(domain, auth);
    const migrations = path.join(root, "migrations");
    await mkdir(migrations);
    await copyFile(
      "db/migrations/0001_extensions.sql",
      path.join(migrations, "0001_extensions.sql"),
    );

    await t.test(
      "migration is repeatable, installs btree_gist and detects drift",
      async () => {
        assert.deepEqual(await migrate(migration, migrations), [
          "0001_extensions.sql",
        ]);
        assert.deepEqual(await migrate(migration, migrations), []);
        assert.equal(
          (
            await migration.query(
              "SELECT extversion FROM pg_extension WHERE extname = 'btree_gist'",
            )
          ).rowCount,
          1,
        );
        const original = await readFile(
          path.join(migrations, "0001_extensions.sql"),
          "utf8",
        );
        await writeFile(
          path.join(migrations, "0001_extensions.sql"),
          `${original}\n-- changed`,
        );
        await assert.rejects(migrate(migration, migrations), /must not/);
        await writeFile(path.join(migrations, "0001_extensions.sql"), original);
      },
    );

    await t.test(
      "a failed migration rolls back its DDL and history",
      async () => {
        await writeFile(
          path.join(migrations, "0002_failure.sql"),
          "CREATE TABLE domain.failed_migration (id integer); SELECT * FROM nonexistent_table;",
        );
        await assert.rejects(migrate(migration, migrations));
        assert.equal(
          (
            await migration.query(
              "SELECT to_regclass('domain.failed_migration') AS name",
            )
          ).rows[0].name,
          null,
        );
        assert.equal(
          (
            await migration.query(
              "SELECT count(*)::int AS total FROM quenda_meta.migrations",
            )
          ).rows[0].total,
          1,
        );
        await rm(path.join(migrations, "0002_failure.sql"));
      },
    );

    await t.test(
      "runtime roles cannot own schemas, migrate or access the other domain",
      async () => {
        await assertRuntimeRole(domain);
        await assertRuntimeRole(auth);
        const privileged = new Pool({
          connectionString: url("quenda_migrator", passwords.migration),
        });
        pools.push(privileged);
        await assert.rejects(assertRuntimeRole(privileged), /Unsafe/);
        await admin.query(
          "CREATE ROLE test_privileged NOLOGIN BYPASSRLS; GRANT test_privileged TO quenda_domain",
        );
        await assert.rejects(assertRuntimeRole(domain), /Unsafe/);
        await admin.query(
          "REVOKE test_privileged FROM quenda_domain; DROP ROLE test_privileged",
        );
        await assertRuntimeRole(domain);
        await assert.rejects(
          domain.query("CREATE TABLE domain.forbidden (id integer)"),
          { code: "42501" },
        );
        await assert.rejects(
          domain.query("SELECT * FROM quenda_meta.migrations"),
          { code: "42501" },
        );
        await migration.query(
          "CREATE TABLE domain.test_items (id integer PRIMARY KEY); GRANT SELECT, INSERT ON domain.test_items TO quenda_domain",
        );
        await assert.rejects(auth.query("SELECT * FROM domain.test_items"), {
          code: "42501",
        });
      },
    );

    await t.test(
      "commit and rollback use one client and release it to a one-connection pool",
      async () => {
        await transaction(domain, async (client) => {
          assert.equal(
            (await client.query("SHOW transaction_isolation")).rows[0]
              .transaction_isolation,
            "serializable",
          );
          await client.query(
            "INSERT INTO domain.test_items (id) VALUES ($1)",
            [1],
          );
        });
        const failure = new Error("command failed");
        await assert.rejects(
          transaction(domain, async (client) => {
            await client.query(
              "INSERT INTO domain.test_items (id) VALUES ($1)",
              [2],
            );
            throw failure;
          }),
          (error) => error === failure,
        );
        assert.deepEqual(
          (await domain.query("SELECT id FROM domain.test_items ORDER BY id"))
            .rows,
          [{ id: 1 }],
        );
        await assert.rejects(
          transaction(domain, async (client) => {
            await client.query("SELECT * FROM nonexistent_table");
          }),
        );
        assert.equal((await domain.query("SELECT 1 AS ok")).rows[0].ok, 1);
      },
    );

    await migrate(migration, path.resolve("db/migrations"));
    for (const entry of ["src/server.ts", "dist/server.js"]) {
      await t.test(
        `backend ${entry} starts with runtime credentials and exits cleanly on SIGTERM`,
        async () => {
          const httpPort = await freePort();
          const child = spawn(process.execPath, [entry], {
            env: {
              HOST: "127.0.0.1",
              PORT: String(httpPort),
              LOG_LEVEL: "silent",
              AUTH_ORIGIN: `http://127.0.0.1:${httpPort}`,
              AUTH_SECRET: randomBytes(32).toString("hex"),
              LOCAL_MAIL_DIR: path.join(root, "mail"),
              DOMAIN_DATABASE_URL: url("quenda_domain", passwords.domain),
              AUTH_DATABASE_URL: url("quenda_auth", passwords.auth),
            },
            stdio: ["ignore", "pipe", "pipe"],
          });
          let output = "";
          child.stdout.on("data", (chunk) => {
            output += chunk;
          });
          child.stderr.on("data", (chunk) => {
            output += chunk;
          });
          const exited = once(child, "exit");
          try {
            let ready = false;
            for (let i = 0; i < 60; i++) {
              assert.equal(child.exitCode, null, output);
              try {
                ready = (
                  await fetch(`http://127.0.0.1:${httpPort}/health/ready`, {
                    signal: AbortSignal.timeout(300),
                  })
                ).ok;
              } catch {
                /* Wait for listener startup. */
              }
              if (ready) break;
              await delay(100);
            }
            assert.ok(ready, "Server did not become ready");
            child.kill("SIGTERM");
            const [code] = await exited;
            assert.equal(code, 0);
            assert.ok(!output.includes(passwords.domain));
          } finally {
            if (child.exitCode === null) {
              child.kill("SIGKILL");
              await exited;
            }
          }
        },
      );
    }
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
});
