import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { reconcileRestore } from "./lib/reconcile.ts";

async function run() {
  const connectionString = process.env.RESTORE_ADMIN_DATABASE_URL;
  if (!connectionString || process.argv.length !== 2)
    throw new Error("Invalid configuration");
  const client = new Client({ connectionString });
  try {
    await client.connect();
    const report = await reconcileRestore(
      client,
      fileURLToPath(new URL("../db/migrations", import.meta.url)),
    );
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (report.status === "INCONSISTENT") process.exitCode = 2;
  } finally {
    await client.end();
  }
}
run().catch(() => {
  process.stderr.write(
    "Reconciliation failed; keep the destination closed and inspect it with authorized credentials\n",
  );
  process.exitCode = 1;
});
