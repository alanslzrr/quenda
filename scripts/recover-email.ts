import { Client } from "pg";
import { readMailConfiguration } from "../src/mail/config.ts";
import { createMailTransport } from "../src/mail/transport.ts";
import { recoverEmail } from "./lib/recover-email.ts";

async function run() {
  const [
    accountId,
    newEmail,
    performedBy,
    identityReference,
    reason,
    ...extra
  ] = process.argv.slice(2);
  if (
    !accountId ||
    !newEmail ||
    !performedBy ||
    !identityReference ||
    !reason ||
    extra.length ||
    !process.env.MIGRATION_DATABASE_URL ||
    !process.env.AUTH_ORIGIN
  )
    throw new Error("Recovery evidence and maintenance configuration required");
  const client = new Client({
    connectionString: process.env.MIGRATION_DATABASE_URL,
  });
  try {
    await client.connect();
    await recoverEmail(
      client,
      accountId,
      newEmail,
      { performedBy, identityReference, reason },
      createMailTransport(readMailConfiguration(process.env)),
      process.env.AUTH_ORIGIN,
    );
    process.stdout.write(
      "Verification sent to the new address; global identity has not changed\n",
    );
  } finally {
    await client.end();
  }
}
run().catch(() => {
  process.stderr.write(
    "Email recovery failed; verify identity evidence, active account, address availability and mail configuration\n",
  );
  process.exitCode = 1;
});
