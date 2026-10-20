import { Client } from "pg";
import { provisionWorker } from "./lib/provision-worker.ts";

async function run() {
  const connectionString = process.env.BOOTSTRAP_DATABASE_URL;
  const password = process.env.WORKER_DATABASE_PASSWORD;
  if (!connectionString || !password) throw new Error("Missing configuration");
  const client = new Client({ connectionString });
  try {
    await client.connect();
    await provisionWorker(client, password);
    process.stdout.write("Worker role created; apply pending migrations\n");
  } finally {
    await client.end();
  }
}
run().catch(() => {
  process.stderr.write(
    "Worker provisioning failed; verify the dedicated database, administrative credentials and absence of the worker role\n",
  );
  process.exitCode = 1;
});
