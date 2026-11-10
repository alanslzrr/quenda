import { spawnSync } from "node:child_process";

// Desktop and phone share one run; the tablet run starts its own server and
// database. Arguments such as spec files are forwarded to both runs.
const args = process.argv.slice(2);
for (const config of ["playwright.config.ts", "playwright.tablet.config.ts"]) {
  const run = spawnSync("playwright", ["test", "--config", config, ...args], {
    stdio: "inherit",
  });
  if (run.status !== 0) process.exit(run.status ?? 1);
}
