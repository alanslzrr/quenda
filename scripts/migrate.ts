import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { migrate } from "./lib/migrations.ts";

async function run() {
  if (!process.env.MIGRATION_DATABASE_URL)
    throw new Error("Missing migration URL");
  const client = new Client({
    connectionString: process.env.MIGRATION_DATABASE_URL,
  });
  try {
    await client.connect();
    const files = await migrate(
      client,
      fileURLToPath(new URL("../db/migrations", import.meta.url)),
    );
    process.stdout.write(`${files.length} migrations applied\n`);
  } finally {
    await client.end();
  }
}
run().catch(() => {
  process.stderr.write(
    "Migration failed; verify the migration role and files\n",
  );
  process.exitCode = 1;
});
