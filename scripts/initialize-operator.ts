import { Client } from "pg";
import { initializeOperator } from "./lib/initialize-operator.ts";

async function run() {
  const [accountId, ...extra] = process.argv.slice(2);
  if (!accountId || extra.length || !process.env.MIGRATION_DATABASE_URL)
    throw new Error(
      "An account identifier and maintenance configuration are required",
    );
  const client = new Client({
    connectionString: process.env.MIGRATION_DATABASE_URL,
  });
  try {
    await client.connect();
    await initializeOperator(client, accountId);
    process.stdout.write("First operator initialized\n");
  } finally {
    await client.end();
  }
}
run().catch(() => {
  process.stderr.write(
    "Operator initialization failed; verify the account, MFA and initialization state\n",
  );
  process.exitCode = 1;
});
