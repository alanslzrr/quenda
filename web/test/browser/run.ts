import { spawnSync } from "node:child_process";
import { connect } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

// Desktop and phone share one run; the tablet run starts its own server and
// database. Arguments such as spec files are forwarded to both runs.
const args = process.argv.slice(2);
const ports = [5173, Number(process.env.QUENDA_TEST_API_PORT ?? 3000)];

const listening = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });

// A server from the previous run, or from another process, would make the next
// run fail to start or talk to the wrong backend.
async function waitForFreePorts() {
  for (let attempt = 0; attempt < 40; attempt++) {
    const busy = [];
    for (const port of ports) if (await listening(port)) busy.push(port);
    if (!busy.length) return;
    if (attempt === 39) {
      process.stderr.write(
        `Ports ${busy.join(", ")} are in use; stop the process holding them and retry\n`,
      );
      process.exit(1);
    }
    await delay(500);
  }
}

for (const config of ["playwright.config.ts", "playwright.tablet.config.ts"]) {
  await waitForFreePorts();
  const run = spawnSync("playwright", ["test", "--config", config, ...args], {
    stdio: "inherit",
  });
  if (run.status !== 0) process.exit(run.status ?? 1);
}
