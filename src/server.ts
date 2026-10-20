import { buildApp } from "./app.ts";
import { ConfigurationError, readConfig } from "./config.ts";
import { createDatabases } from "./database/pools.ts";
import { startDatabaseReporting } from "./database/reporting.ts";
import { loadSourceOffer } from "./http/source-offer.ts";
import { createMailTransport } from "./mail/transport.ts";
import { createAuthentication } from "./modules/identity/index.ts";

async function start(): Promise<void> {
  const config = readConfig(process.env);
  const sourceOffer = await loadSourceOffer(process.env);
  const database = createDatabases(config);
  const identityConfig = {
    origin: config.authOrigin,
    secret: config.authSecret,
  };
  const authentication = createAuthentication(
    database.auth,
    identityConfig,
    createMailTransport(config.mail),
  );
  const app = await buildApp({
    database,
    ...(sourceOffer ? { sourceOffer } : {}),
    domain: database.domain,
    idempotencyRetentionSeconds: config.idempotencyRetentionSeconds,
    logLevel: config.logLevel,
    identity: { authentication, config: identityConfig },
  });
  const stopMetrics = startDatabaseReporting(database, app.log);
  app.addHook("onClose", async () => {
    stopMetrics();
  });
  try {
    await database.check();
    await database.auth.query('SELECT id FROM auth."user" LIMIT 0');
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
