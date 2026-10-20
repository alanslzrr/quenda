import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const execute = promisify(execFile);
const image = process.env.QUENDA_IMAGE ?? "quenda-backend:local";
const postgres =
  "postgres:17.11@sha256:2d2b8998d31037bf721cfdf764d76ba74171b4fab3431b7f72c27c56ddbdf9e3";
const docker = (...args: string[]) =>
  execute("docker", args, { timeout: 60000, maxBuffer: 1024 * 1024 });

async function eventually(check: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await check().catch(() => false)) return;
    await delay(250);
  }
  assert.fail("Container did not become ready");
}

test("one OCI artifact migrates and runs isolated shared and dedicated installations", {
  timeout: 240000,
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "quenda-oci-"));
  const network = `quenda-test-${randomUUID()}`;
  const containers: string[] = [];
  const envFile = async (name: string, values: Record<string, string>) => {
    const file = path.join(root, name);
    await writeFile(
      file,
      Object.entries(values)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n"),
      { mode: 0o600 },
    );
    return file;
  };
  const run = (env: string, ...args: string[]) =>
    docker(
      "run",
      "--rm",
      "--network",
      network,
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--env-file",
      env,
      image,
      ...args,
    );
  const fetchFrom = async (container: string, route: string) =>
    JSON.parse(
      (
        await docker(
          "exec",
          container,
          "node",
          "-e",
          `fetch('http://127.0.0.1:3000${route}').then(async r=>console.log(JSON.stringify({status:r.status,body:await r.json()})))`,
        )
      ).stdout,
    );
  await docker("network", "create", "--internal", network);
  try {
    const installations: {
      api: string;
      db: string;
      tenants: string[];
      authEnv: string;
    }[] = [];
    for (const [index, count] of [2, 1].entries()) {
      const db = `${network}-db-${index}`,
        api = `${network}-api-${index}`;
      const passwords = Object.fromEntries(
        ["bootstrap", "migration", "domain", "auth", "worker"].map((role) => [
          role,
          randomBytes(24).toString("hex"),
        ]),
      );
      const url = (role: string, password: string | undefined) =>
        `postgresql://${role}:${password}@${db}:5432/quenda`;
      const pgEnv = await envFile(`postgres-${index}`, {
        POSTGRES_USER: "quenda_bootstrap",
        POSTGRES_DB: "quenda",
        POSTGRES_PASSWORD: passwords.bootstrap as string,
      });
      containers.push(db);
      await docker(
        "run",
        "-d",
        "--name",
        db,
        "--network",
        network,
        "--env-file",
        pgEnv,
        postgres,
      );
      await eventually(async () =>
        (
          await docker(
            "exec",
            db,
            "pg_isready",
            "-h",
            "127.0.0.1",
            "-U",
            "quenda_bootstrap",
            "-d",
            "quenda",
          )
        ).stdout.includes("accepting connections"),
      );
      const setup = await envFile(`setup-${index}`, {
        BOOTSTRAP_DATABASE_URL: url("quenda_bootstrap", passwords.bootstrap),
        MIGRATION_DATABASE_URL: url("quenda_migrator", passwords.migration),
        MIGRATION_DATABASE_PASSWORD: passwords.migration as string,
        DOMAIN_DATABASE_PASSWORD: passwords.domain as string,
        AUTH_DATABASE_PASSWORD: passwords.auth as string,
        WORKER_DATABASE_PASSWORD: passwords.worker as string,
      });
      await run(setup, "scripts/bootstrap.ts");
      assert.match(
        (await run(setup, "scripts/migrate.ts")).stdout,
        /migrations applied/,
      );
      assert.match(
        (await run(setup, "scripts/migrate.ts")).stdout,
        /^0 migrations applied/,
      );
      const tenants = Array.from({ length: count }, () => randomUUID());
      // Synthetic fixtures test deployment isolation, not the user onboarding flow.
      await run(
        setup,
        "--input-type=module",
        "-e",
        `
        import { Client } from 'pg';
        const c=new Client({connectionString:process.env.MIGRATION_DATABASE_URL}); await c.connect();
        for (const id of ${JSON.stringify(tenants)}) {
          await c.query("INSERT INTO domain.municipality(id,name,timezone) VALUES($1,'Synthetic','Europe/Madrid')",[id]);
          await c.query("INSERT INTO domain.facility(tenant_id,id,name,published_at) VALUES($1,$2,'Synthetic facility',now())",[id,crypto.randomUUID()]);
        }
        await c.end();
      `,
      );
      const mail = {
        AUTH_ORIGIN: "https://quenda.test",
        MAIL_TRANSPORT: "smtp",
        SMTP_HOST: "mail.invalid",
        SMTP_FROM: "quenda@example.test",
        EMAIL_LOCALE: "gl",
      };
      const apiEnv = await envFile(`api-${index}`, {
        ...mail,
        AUTH_SECRET: randomBytes(32).toString("hex"),
        DOMAIN_DATABASE_URL: url("quenda_domain", passwords.domain),
        AUTH_DATABASE_URL: url("quenda_auth", passwords.auth),
      });
      containers.push(api);
      await docker(
        "run",
        "-d",
        "--name",
        api,
        "--network",
        network,
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--env-file",
        apiEnv,
        image,
      );
      await eventually(
        async () => (await fetchFrom(api, "/health/ready")).status === 200,
      );
      assert.equal(
        (
          await docker(
            "exec",
            api,
            "node",
            "-e",
            "console.log(Boolean(process.env.MIGRATION_DATABASE_URL || process.env.WORKER_DATABASE_URL || process.env.BOOTSTRAP_DATABASE_URL))",
          )
        ).stdout.trim(),
        "false",
      );
      await docker(
        "exec",
        api,
        "node",
        "--input-type=module",
        "-e",
        `
        import assert from 'node:assert/strict';
        import { readFileSync } from 'node:fs';
        import { createHash } from 'node:crypto';
        const response = await fetch('http://127.0.0.1:3000/legal/source');
        assert.equal(response.status, 200);
        const bytes = Buffer.from(await response.arrayBuffer());
        assert.deepEqual(bytes, readFileSync(process.env.SOURCE_ARCHIVE_PATH));
        assert.equal(createHash('sha256').update(bytes).digest('hex'), process.env.SOURCE_ARCHIVE_SHA256);
        assert.equal(response.headers.get('x-source-revision'), process.env.SOURCE_REVISION);
        assert.ok(response.headers.get('link').includes('/legal/source'));
      `,
      );
      const workerEnv = await envFile(`worker-${index}`, {
        ...mail,
        WORKER_DATABASE_URL: url("quenda_worker", passwords.worker),
      });
      const work = await run(workerEnv, "dist/email-worker.js", "--once");
      assert.match(work.stdout, /EMAIL_QUEUE_HEALTH/);
      const authEnv = await envFile(`auth-${index}`, {
        AUTH_DATABASE_URL: url("quenda_auth", passwords.auth),
      });
      installations.push({ api, db, tenants, authEnv });
    }
    for (const installation of installations) {
      for (const tenant of installation.tenants) {
        const result = await fetchFrom(
          installation.api,
          `/api/public/municipalities/${tenant}/facilities`,
        );
        assert.equal(result.status, 200);
        assert.equal(result.body.items.length, 1);
      }
      const foreign = installations.find(
        (candidate) => candidate !== installation,
      );
      assert.ok(foreign);
      const result = await fetchFrom(
        installation.api,
        `/api/public/municipalities/${foreign.tenants[0]}/facilities`,
      );
      assert.equal(result.body.items.length, 0);
      await assert.rejects(
        run(
          foreign.authEnv,
          "--input-type=module",
          "-e",
          `import { Client } from 'pg'; const u=new URL(process.env.AUTH_DATABASE_URL);u.hostname='${installation.db}';const c=new Client({connectionString:u.toString()});try {await c.connect();await c.end();} catch (error) {if(error.code!=='28P01') process.exit(2);console.log('AUTHENTICATION_REJECTED');process.exit(1);}`,
        ),
        (error: unknown) => {
          const failure = error as { code: number; stdout: string };
          assert.equal(failure.code, 1);
          assert.match(failure.stdout, /AUTHENTICATION_REJECTED/);
          return true;
        },
      );
      await docker("stop", "--time", "10", installation.db);
      assert.equal(
        (await fetchFrom(installation.api, "/health/ready")).status,
        503,
      );
      await docker("start", installation.db);
      await eventually(
        async () =>
          (await fetchFrom(installation.api, "/health/ready")).status === 200,
      );
      await docker("restart", "--time", "10", installation.api);
      await eventually(
        async () =>
          (await fetchFrom(installation.api, "/health/ready")).status === 200,
      );
      const after = await fetchFrom(
        installation.api,
        `/api/public/municipalities/${installation.tenants[0]}/facilities`,
      );
      assert.equal(after.body.items.length, 1);
    }
  } finally {
    for (const container of containers.reverse())
      await docker("rm", "-f", "-v", container).catch(() => {});
    await docker("network", "rm", network).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
