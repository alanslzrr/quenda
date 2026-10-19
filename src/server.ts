import { buildApp } from "./app.ts";
import { ConfigurationError, readConfig } from "./config.ts";
import { createDatabases } from "./database/pools.ts";

async function start(): Promise<void> {
  const config = readConfig(process.env);
  const database = createDatabases(config);
  const app = await buildApp({ database, logLevel: config.logLevel });
  try {
    await database.check();
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    await app.close();
    throw error;
  }
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    const deadline = setTimeout(() => {
      process.exit(1);
    }, 10000).unref();
    void app.close().then(
      () => {
        clearTimeout(deadline);
      },
      () => {
        clearTimeout(deadline);
        process.exitCode = 1;
      },
    );
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

start().catch((error: unknown) => {
  process.stderr.write(
    error instanceof ConfigurationError
      ? `${error.message}\n`
      : "Backend startup failed\n",
  );
  process.exitCode = 1;
});
