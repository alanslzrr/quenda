import { Client } from "pg";
import { bootstrap } from "./lib/bootstrap.ts";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};

async function run() {
  const client = new Client({
    connectionString: required("BOOTSTRAP_DATABASE_URL"),
  });
  try {
    await client.connect();
    await bootstrap(client, {
      migration: required("MIGRATION_DATABASE_PASSWORD"),
      domain: required("DOMAIN_DATABASE_PASSWORD"),
      auth: required("AUTH_DATABASE_PASSWORD"),
      worker: required("WORKER_DATABASE_PASSWORD"),
    });
    process.stdout.write("Database roles and schemas created\n");
  } finally {
    await client.end();
  }
}

run().catch(() => {
  process.stderr.write(
    "Database bootstrap failed; verify the dedicated database and credentials\n",
  );
  process.exitCode = 1;
});
