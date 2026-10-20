import { Client } from "pg";
import {
  readPrivacyCheckpoint,
  reconcilePrivacyCheckpoint,
} from "./lib/privacy-checkpoint.ts";

async function run() {
  const connectionString = process.env.RESTORE_ADMIN_DATABASE_URL;
  const [file, checksum, reference, ...extra] = process.argv.slice(2);
  if (!connectionString || !file || !checksum || !reference || extra.length)
    throw new Error(
      "Closed destination, checkpoint checksum and recovery authorization required",
    );
  const checkpoint = await readPrivacyCheckpoint(file, checksum);
  const client = new Client({ connectionString });
  try {
    await client.connect();
    const result = await reconcilePrivacyCheckpoint(
      client,
      checkpoint,
      checksum,
      reference,
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await client.end();
  }
}
run().catch(() => {
  process.stderr.write(
    "Privacy reconciliation failed; keep the destination closed and verify the latest external suppression journal\n",
  );
  process.exitCode = 1;
});
