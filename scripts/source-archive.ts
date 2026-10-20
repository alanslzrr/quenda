import { sourceArchive } from "./lib/source-archive.ts";

async function run() {
  const [destination, ...extra] = process.argv.slice(2);
  if (!destination || extra.length)
    throw new Error("Provide one new archive path");
  process.stdout.write(
    `${JSON.stringify(await sourceArchive(process.cwd(), destination))}\n`,
  );
}
run().catch(() => {
  process.stderr.write(
    "Source archive failed; verify a clean committed repository, permitted files and a new destination\n",
  );
  process.exitCode = 1;
});
