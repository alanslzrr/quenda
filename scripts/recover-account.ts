import { Client } from "pg";
import { recoverAccount } from "./lib/recover-account.ts";

async function run() {
  const [
    accountId,
    performedBy,
    identityReference,
    remediationReference,
    reason,
    ...extra
  ] = process.argv.slice(2);
  if (
    !accountId ||
    !performedBy ||
    !identityReference ||
    !remediationReference ||
    !reason ||
    extra.length ||
    !process.env.MIGRATION_DATABASE_URL
  )
    throw new Error("Recovery evidence and maintenance configuration required");
  const client = new Client({
    connectionString: process.env.MIGRATION_DATABASE_URL,
  });
  try {
    await client.connect();
    await recoverAccount(client, accountId, {
      performedBy,
      identityReference,
      remediationReference,
      reason,
    });
    process.stdout.write(
      "Personal access recovered; administrative permissions remain revoked\n",
    );
  } finally {
    await client.end();
  }
}
run().catch(() => {
  process.stderr.write(
    "Recovery failed; verify identity, remediation, replaced compromised credentials and retained inactive account\n",
  );
  process.exitCode = 1;
});
