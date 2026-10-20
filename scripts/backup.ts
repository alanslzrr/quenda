import { createBackup } from "./lib/backup.ts";

async function run() {
  const connection = process.env.BACKUP_DATABASE_URL,
    bin = process.env.PG_BIN;
  const [destination, ...extra] = process.argv.slice(2);
  if (!connection || !bin || !destination || extra.length)
    throw new Error("Missing backup configuration");
  process.stdout.write(
    `${JSON.stringify(await createBackup(connection, destination, bin))}\n`,
  );
}
run().catch(() => {
  process.stderr.write(
    "Backup failed; verify PostgreSQL 17, full database read privileges and a new destination in a private directory\n",
  );
  process.exitCode = 1;
});
