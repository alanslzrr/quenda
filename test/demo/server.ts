import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import path from "node:path";
import { buildApp } from "../../src/app.ts";
import { localMail } from "../../src/mail/local.ts";
import { createAuthentication } from "../../src/modules/identity/index.ts";
import { withDatabase } from "../helpers/postgres.ts";
import {
  type DemoAccess,
  demoApiOrigin,
  demoWebOrigin,
  parseDemoAccess,
  registerDemoRun,
  writeDemoAccess,
} from "./access-state.ts";
import { seedDemo } from "./seed.ts";

// Local review server: ephemeral database, local mail sink, no external delivery.
const apiPort = 3100;
const webPort = 5174;
await withDatabase(async ({ auth, domain, migration }) => {
  const config = {
    origin: demoWebOrigin,
    secret: randomBytes(32).toString("hex"),
  };
  const authentication = createAuthentication(
    auth,
    config,
    localMail(path.resolve(".local/demo-mail")),
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
    logLevel: "warn",
  });
  const run = {
    runId: randomUUID(),
    processId: process.pid,
    startedAt: new Date().toISOString(),
  };
  registerDemoRun(app, run);
  try {
    const demo = await seedDemo(app, auth, domain, migration, config.origin);
    assert.ok(demo.administratorSecret);
    const access: DemoAccess = parseDemoAccess({
      version: 1,
      ...run,
      apiOrigin: demoApiOrigin,
      webOrigin: demoWebOrigin,
      administrator: demo.administrator,
      administratorSecret: demo.administratorSecret,
    });
    await app.listen({ host: "127.0.0.1", port: apiPort });
    await writeDemoAccess(path.resolve(".local/demo"), access);
    console.log(`
Quenda · demostración local
  Web:            ${config.origin}/municipios/${demo.entry}
  Arranque web:   QUENDA_API=http://127.0.0.1:${apiPort} pnpm --dir web exec vite --host 127.0.0.1 --port ${webPort}
  Vecina:         ${demo.citizen}
  Administración: ${demo.administrator}
  Código MFA:     pnpm demo:code (verifica el arranque vigente)
  Contraseña:     ${demo.password}
`);
    await Promise.race([once(process, "SIGTERM"), once(process, "SIGINT")]);
  } finally {
    await app.close();
  }
});
