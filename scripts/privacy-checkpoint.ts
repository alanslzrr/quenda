import { Client } from "pg";
import { writePrivacyCheckpoint } from "./lib/privacy-checkpoint.ts";

async function run() {
  const connectionString = process.env.MIGRATION_DATABASE_URL;
  const [destination, ...extra] = process.argv.slice(2);
  if (!connectionString || !destination || extra.length)
    throw new Error(
      "Maintenance database and new private destination required",
    );
  const client = new Client({ connectionString });
  try {
    await client.connect();
    process.stdout.write(
      `${JSON.stringify(await writePrivacyCheckpoint(client, destination))}\n`,
    );
  } finally {
    await client.end();
  }
}
run().catch(() => {
  process.stderr.write(
    "Privacy checkpoint failed; no restored database may be reopened without current verified suppression evidence\n",
  );
  process.exitCode = 1;
});
