import { Pool } from "pg";
import { buildApp } from "../../src/app.ts";
import { createAuthentication } from "../../src/modules/identity/index.ts";
import type { MailTransport } from "../../src/shared/mail.ts";
import { seedCloudDemo } from "../../test/demo/cloud.ts";

// Loads the demonstration dataset into a fresh production installation, once.
// Runs inside the `data` network with the runtime and migration credentials;
// prints the access file (accounts, password, TOTP secrets) on stdout.

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

// Seeding signs up accounts through the API: their verification mails would go
// to unreachable demo addresses, so nothing is delivered.
const discard: MailTransport = { async send() {} };

async function run() {
  const origin = required("AUTH_ORIGIN");
  const secret = required("AUTH_SECRET");
  const password = required("DEMO_PASSWORD");
  const pool = (name: string) =>
    new Pool({ connectionString: required(name), max: 4 });
  const domain = pool("DOMAIN_DATABASE_URL");
  const auth = pool("AUTH_DATABASE_URL");
  const migration = pool("MIGRATION_DATABASE_URL");
  try {
    const existing = await migration.query<{ accounts: number; tenants: number }>(
      `SELECT (SELECT count(*) FROM auth."user")::int AS accounts,
              (SELECT count(*) FROM domain.municipality)::int AS tenants`,
    );
    const row = existing.rows[0];
    if (!row || row.accounts || row.tenants)
      throw new Error("The demo only seeds an installation without data");
    const config = { origin, secret };
    const app = await buildApp({
      database: {
        check: async () => {
          await domain.query("SELECT 1");
        },
        close: async () => {},
      },
      domain,
      identity: {
        authentication: createAuthentication(auth, config, discard),
        config,
      },
      logLevel: "warn",
    });
    try {
      const access = await seedCloudDemo(app, { auth, domain, migration }, {
        origin,
        password,
      });
      process.stdout.write(`${JSON.stringify(access, null, 2)}\n`);
    } finally {
      await app.close();
    }
  } finally {
    await Promise.all([domain.end(), auth.end(), migration.end()]);
  }
}

run().catch((error: Error) => {
  process.stderr.write(`Demo seeding failed: ${error.message}\n`);
  process.exitCode = 1;
});
