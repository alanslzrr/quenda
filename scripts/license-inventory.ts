import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dependencyPaths, licenseInventory } from "./lib/license-inventory.ts";

const execute = promisify(execFile);
async function run() {
  const tree = async (production: boolean) =>
    JSON.parse(
      (
        await execute(
          "pnpm",
          [
            "list",
            "--depth",
            "Infinity",
            "--json",
            ...(production ? ["--prod"] : []),
          ],
          { maxBuffer: 16 * 1024 * 1024 },
        )
      ).stdout,
    );
  const report = await licenseInventory(
    dependencyPaths(await tree(false)),
    dependencyPaths(await tree(true)),
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status === "REVIEW_REQUIRED") process.exitCode = 2;
}
run().catch(() => {
  process.stderr.write(
    "Dependency license inventory failed; no complete report is available\n",
  );
  process.exitCode = 1;
});
