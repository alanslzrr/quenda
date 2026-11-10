import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { buildApp } from "../../src/app.ts";
import { localMail } from "../../src/mail/local.ts";
import { createAuthentication } from "../../src/modules/identity/index.ts";
import { withDatabase } from "./postgres.ts";
import { seedArrivalBrowser } from "./web-arrival.ts";
import { browserCatalog, seedWebCatalog } from "./web-catalog.ts";
import { seedImportBrowser } from "./web-import.ts";
import { seedMunicipalBrowser } from "./web-municipal.ts";
import { seedPlatformBrowser } from "./web-platform.ts";
import { seedPrivacyBrowser } from "./web-privacy.ts";
import { seedReportingBrowser } from "./web-reporting.ts";
import { seedStaffRecipient } from "./web-staff.ts";

// Browser tests own an ephemeral database and local mail sink. No production
// credentials, external mail delivery or debug HTTP endpoints are involved.
await withDatabase(async ({ auth, domain, migration, worker }) => {
  for (let index = 1; index <= 4; index++) {
    const catalog = browserCatalog(index);
    await seedWebCatalog(auth, migration, catalog);
    await migration.query(
      "UPDATE domain.municipality SET name=$2 WHERE id=$1",
      [catalog.tenant, `Oleiros de proba ${index}`],
    );
  }
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
  // Model separate browser clients without disabling authentication rate limits.
  // This hook exists only in the isolated test process, never in buildApp.
  app.addHook("onRequest", async (request) => {
    const client = request.headers["x-quenda-test-client"];
    if (
      typeof client === "string" &&
      client.startsWith("2001:db8:") &&
      isIP(client) === 6
    )
      Object.defineProperty(request, "ip", { value: client });
  });
  const municipalFixtures = [];
  // Separate accounts keep repeated editor regressions within the real per-account limits.
  for (const index of [
    ...Array.from({ length: 10 }, (_, i) => i + 1),
    ...Array.from({ length: 10 }, (_, i) => i + 35),
    // Catalog profile editing owns these two so it never shares state with another spec.
    45,
    46,
    // Legal text publication owns these two so it never shares state with another spec.
    47,
    48,
    // The catalog download owns these two.
    49,
    50,
    // Lost-response creation recovery has separate accounts and resources.
    51,
    52,
  ])
    municipalFixtures.push(
      await seedMunicipalBrowser(app, auth, domain, migration, index),
    );
  await mkdir("web/test-results", { recursive: true });
  await writeFile(
    "web/test-results/municipal-fixtures.json",
    JSON.stringify(municipalFixtures),
  );
  const staffFixtures = [];
  for (let index = 11; index <= 16; index++) {
    staffFixtures.push({
      administrator: await seedMunicipalBrowser(
        app,
        auth,
        domain,
        migration,
        index,
      ),
      recipient: await seedStaffRecipient(app, auth, index),
    });
  }
  await writeFile(
    "web/test-results/staff-fixtures.json",
    JSON.stringify(staffFixtures),
  );
  const collaborationFixtures = [];
  for (let index = 17; index <= 20; index++)
    collaborationFixtures.push(
      await seedMunicipalBrowser(app, auth, domain, migration, index),
    );
  await writeFile(
    "web/test-results/collaboration-fixtures.json",
    JSON.stringify(collaborationFixtures),
  );
  const privacyFirst = await seedPrivacyBrowser(
    app,
    auth,
    domain,
    migration,
    21,
  );
  const privacySecond = await seedPrivacyBrowser(
    app,
    auth,
    domain,
    migration,
    22,
    privacyFirst.accountId,
  );
  await writeFile(
    "web/test-results/privacy-fixtures.json",
    JSON.stringify([privacyFirst, privacySecond]),
  );
  const platformFixtures = [];
  for (const index of [23, 25, 27, 29])
    platformFixtures.push(
      await seedPlatformBrowser(
        app,
        auth,
        domain,
        index,
        privacyFirst.accountId,
      ),
    );
  await writeFile(
    "web/test-results/platform-fixtures.json",
    JSON.stringify(platformFixtures),
  );
  const reportingFixtures = [];
  for (const index of [31, 33])
    reportingFixtures.push(
      await seedReportingBrowser(app, auth, domain, migration, worker, index),
    );
  await writeFile(
    "web/test-results/reporting-fixtures.json",
    JSON.stringify(reportingFixtures),
  );
  // Arrival owns municipal indexes 53 and 54, one per project.
  const arrivalFixtures = [];
  for (const index of [53, 54])
    arrivalFixtures.push(
      await seedArrivalBrowser(app, auth, domain, migration, index),
    );
  await writeFile(
    "web/test-results/arrival-fixtures.json",
    JSON.stringify(arrivalFixtures),
  );
  // Usage analytics owns municipal indexes 55 and 56, one per project.
  const analyticsFixtures = [];
  for (const index of [55, 56])
    analyticsFixtures.push(
      await seedMunicipalBrowser(app, auth, domain, migration, index),
    );
  await writeFile(
    "web/test-results/analytics-fixtures.json",
    JSON.stringify(analyticsFixtures),
  );
  // Catalog import owns municipal indexes 57 and 58, one per project.
  const importFixtures = [];
  for (const index of [57, 58])
    importFixtures.push(
      await seedImportBrowser(app, auth, domain, migration, index),
    );
  await writeFile(
    "web/test-results/import-fixtures.json",
    JSON.stringify(importFixtures),
  );
  await app.listen({
    host: "127.0.0.1",
    port: Number(process.env.QUENDA_TEST_API_PORT ?? 3000),
  });
  try {
    await Promise.race([once(process, "SIGTERM"), once(process, "SIGINT")]);
  } finally {
    await app.close();
  }
});
