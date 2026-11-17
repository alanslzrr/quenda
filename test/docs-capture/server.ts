import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { buildApp } from "../../src/app.ts";
import { localMail } from "../../src/mail/local.ts";
import { createAuthentication } from "../../src/modules/identity/index.ts";
import { seedCloudDemo } from "../demo/cloud.ts";
import { withDatabase } from "../helpers/postgres.ts";

// Documentation capture server: an ephemeral database seeded with the cloud
// demonstration dataset and a local mail sink. It never reaches the public demo
// or an external mail service; every run starts from the same seeded state.
export const captureApiPort = Number(
  process.env.QUENDA_CAPTURE_API_PORT ?? 3200,
);
export const captureWebPort = Number(
  process.env.QUENDA_CAPTURE_WEB_PORT ?? 5175,
);
const state = path.resolve(".local/capture");
const mail = path.join(state, "mail");

await rm(state, { recursive: true, force: true });
await mkdir(state, { recursive: true, mode: 0o700 });
await withDatabase(
  async ({ auth, domain, migration, worker, administration }) => {
    const config = {
      origin: `http://127.0.0.1:${captureWebPort}`,
      secret: randomBytes(32).toString("hex"),
    };
    const app = await buildApp({
      database: {
        check: async () => {
          await domain.query("SELECT 1");
        },
        close: async () => {},
      },
      domain,
      identity: {
        authentication: createAuthentication(auth, config, localMail(mail)),
        config,
      },
      logLevel: "warn",
    });
    // Each capture scenario declares its own client address so the real
    // authentication rate limits stay enabled. Exists only in this process.
    app.addHook("onRequest", async (request) => {
      const client = request.headers["x-quenda-test-client"];
      if (
        typeof client === "string" &&
        client.startsWith("2001:db8:") &&
        isIP(client) === 6
      )
        Object.defineProperty(request, "ip", { value: client });
    });
    const access = await seedCloudDemo(
      app,
      { auth, domain, migration },
      { origin: config.origin, password: "Demostracion-quenda-2026" },
    );
    // The demo resident prefers Galician; the guides are written in Spanish, so
    // her stored preference follows them instead of switching the UI on sign-in.
    await migration.query(
      `UPDATE domain.account_preferences SET locale='es'
      WHERE account_id=(SELECT id FROM auth."user" WHERE email=$1)`,
      [
        access.accounts.find(
          (item) => item.role === "Vecina (reserva habitual)",
        )?.email,
      ],
    );
    await app.listen({ host: "127.0.0.1", port: captureApiPort });
    // Connection strings let scenarios drive the worker and back-office
    // scripts against this same throwaway database.
    const file = path.join(state, "access.json");
    await writeFile(
      file,
      JSON.stringify({
        ...access,
        mail,
        apiOrigin: `http://127.0.0.1:${captureApiPort}`,
        databases: Object.fromEntries(
          Object.entries({
            auth,
            domain,
            migration,
            worker,
            administration,
          }).map(([name, pool]) => [
            name,
            (pool.options as { connectionString?: string }).connectionString,
          ]),
        ),
      }),
      { mode: 0o600 },
    );
    await chmod(file, 0o600);
    try {
      await Promise.race([once(process, "SIGTERM"), once(process, "SIGINT")]);
    } finally {
      await app.close();
    }
  },
);
