import { randomBytes } from "node:crypto";
import { once } from "node:events";
import path from "node:path";
import { buildApp } from "../../src/app.ts";
import { localMail } from "../../src/mail/local.ts";
import { createAuthentication } from "../../src/modules/identity/index.ts";
import { withDatabase } from "./postgres.ts";

// Browser tests own an ephemeral database and local mail sink. No production
// credentials, external mail delivery or debug HTTP endpoints are involved.
await withDatabase(async ({ auth, domain }) => {
  const config = {
    origin: "http://127.0.0.1:5173",
    secret: randomBytes(32).toString("hex"),
  };
  const authentication = createAuthentication(
    auth,
    config,
    localMail(path.resolve("web/test-results/mail")),
  );
  const app = await buildApp({
    database: {
      check: async () => {
        await domain.query("SELECT 1");
      },
      close: async () => {},
    },
    domain,
    identity: { authentication, config },
    logLevel: "silent",
  });
  await app.listen({ host: "127.0.0.1", port: 3000 });
  try {
    await Promise.race([once(process, "SIGTERM"), once(process, "SIGINT")]);
  } finally {
    await app.close();
  }
});
