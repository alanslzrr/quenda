import { Client } from "pg";
import { recoverOperator } from "./lib/recover-operator.ts";

async function run() {
  const [accountId, performedBy, authorityReference, reason, ...extra] =
    process.argv.slice(2);
  if (
    !accountId ||
    !performedBy ||
    !authorityReference ||
    !reason ||
    extra.length ||
    !process.env.MIGRATION_DATABASE_URL
  )
    throw new Error(
      "Account, operator identity, verified authority reference, reason and maintenance configuration are required",
    );
  const client = new Client({
    connectionString: process.env.MIGRATION_DATABASE_URL,
  });
  try {
    await client.connect();
    await recoverOperator(client, accountId, {
      performedBy,
      authorityReference,
      reason,
    });
    process.stdout.write("Exceptional operator recovery recorded\n");
  } finally {
    await client.end();
  }
}
run().catch(() => {
  process.stderr.write(
    "Operator recovery failed; verify authority, destination account and absence of enabled operators\n",
  );
  process.exitCode = 1;
});
