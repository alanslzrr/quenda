import { restoreBackup } from "./lib/restore.ts";

async function run() {
  const connection = process.env.RESTORE_ADMIN_DATABASE_URL,
    bin = process.env.PG_BIN;
  const [archive, sha256, database, ...extra] = process.argv.slice(2);
  if (!connection || !bin || !archive || !sha256 || !database || extra.length)
    throw new Error("Missing restore configuration");
  process.stdout.write(
    `${JSON.stringify(await restoreBackup(connection, archive, sha256, database, bin))}\n`,
  );
}
run().catch(() => {
  process.stderr.write(
    "Restore failed; inspect the isolated destination. Existing databases are never replaced; a newly created destination remains closed pending review\n",
  );
  process.exitCode = 1;
});
