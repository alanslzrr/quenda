import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { buildApp } from "../../src/app.ts";
import { localMail } from "../../src/mail/local.ts";
import { createAuthentication } from "../../src/modules/identity/index.ts";
import {
  currentDemoCode,
  demoApiOrigin,
  demoWebOrigin,
  parseDemoAccess,
  readDemoAccess,
  registerDemoRun,
  writeDemoAccess,
} from "../demo/access-state.ts";
import { ribasanta, seedDemo, valdeira } from "../demo/seed.ts";
import { browser } from "../helpers/auth-client.ts";
import { withDatabase } from "../helpers/postgres.ts";

test("demo access verifies the seeded run, requires real MFA and isolates municipal administration", {
  timeout: 90000,
}, async () => {
  await withDatabase(async ({ root, auth, domain, migration }) => {
    const config = {
      origin: demoWebOrigin,
      secret: randomBytes(32).toString("hex"),
    };
    const authentication = createAuthentication(
      auth,
      config,
      localMail(path.join(root, "mail")),
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
    const run = {
      runId: randomUUID(),
      processId: process.pid,
      startedAt: new Date().toISOString(),
    };
    registerDemoRun(app, run);
    try {
      const demo = await seedDemo(app, auth, domain, migration, config.origin);
      const metadata = parseDemoAccess({
        version: 1,
        ...run,
        apiOrigin: demoApiOrigin,
        webOrigin: demoWebOrigin,
        administrator: demo.administrator,
        administratorSecret: demo.administratorSecret,
      });
      const directory = path.join(root, "demo-access");
      await writeDemoAccess(directory, metadata);
      const access = await readDemoAccess(directory);
      const request: typeof fetch = async (input) => {
        assert.equal(input, `${demoApiOrigin}/__demo/run`);
        const response = await app.inject("/__demo/run");
        assert.equal(response.statusCode, 200);
        assert.ok(!response.body.includes(access.administratorSecret));
        return new Response(response.body, { status: response.statusCode });
      };
      await assert.rejects(
        currentDemoCode({ ...access, runId: randomUUID() }, request),
        /different launch/,
      );

      const admin = browser(app, "198.51.100.200", config.origin);
      const signin = await admin.request("/api/auth/sign-in/email", {
        email: demo.administrator,
        password: demo.password,
      });
      assert.equal(signin.statusCode, 200, signin.body);
      assert.equal(signin.json().twoFactorRedirect, true);
      assert.equal((await admin.request("/api/me")).statusCode, 401);
      assert.equal(
        (await admin.request(`/api/municipalities/${valdeira.id}/facilities`))
          .statusCode,
        401,
      );

      const { code } = await currentDemoCode(access, request);
      const verified = await admin.request("/api/auth/two-factor/verify-totp", {
        code,
      });
      assert.equal(verified.statusCode, 200, verified.body);
      const me = await admin.request("/api/me");
      assert.equal(me.statusCode, 200, me.body);
      assert.equal(me.json().mfaVerified, true);
      const navigation = await admin.request("/api/me/navigation");
      assert.equal(navigation.statusCode, 200, navigation.body);
      assert.deepEqual(
        navigation
          .json()
          .municipalities.items.map(
            (item: { id: string; administrator: boolean }) => ({
              id: item.id,
              administrator: item.administrator,
            }),
          ),
        [{ id: valdeira.id, administrator: true }],
      );
      assert.equal(navigation.json().platform.operator, false);
      const catalog = await admin.request(
        `/api/municipalities/${valdeira.id}/facilities`,
      );
      assert.equal(catalog.statusCode, 200, catalog.body);
      assert.deepEqual(
        catalog
          .json()
          .items.map((item: { id: string }) => item.id)
          .sort(),
        valdeira.facilities.map((item) => item.id).sort(),
      );
      const foreignList = await admin.request(
        `/api/municipalities/${ribasanta.id}/facilities`,
      );
      assert.equal(foreignList.statusCode, 200, foreignList.body);
      assert.deepEqual(foreignList.json().items, []);
      const foreignDetail = await admin.request(
        `/api/municipalities/${ribasanta.id}/facilities/${ribasanta.facilities[0]?.id}`,
      );
      assert.equal(foreignDetail.statusCode, 403, foreignDetail.body);
      assert.equal(foreignDetail.json().error.code, "FORBIDDEN");

      const citizen = browser(app, "198.51.100.201", config.origin);
      const citizenSignin = await citizen.request("/api/auth/sign-in/email", {
        email: demo.citizen,
        password: demo.password,
      });
      assert.equal(citizenSignin.statusCode, 200, citizenSignin.body);
      const citizenNavigation = await citizen.request("/api/me/navigation");
      assert.equal(citizenNavigation.statusCode, 200, citizenNavigation.body);
      assert.ok(
        citizenNavigation
          .json()
          .municipalities.items.every(
            (item: { administrator: boolean; permissions: unknown[] }) =>
              !item.administrator && item.permissions.length === 0,
          ),
      );
      const citizenAdmin = await citizen.request(
        `/api/municipalities/${valdeira.id}/facilities/${valdeira.facilities[0]?.id}`,
      );
      assert.equal(citizenAdmin.statusCode, 403, citizenAdmin.body);
    } finally {
      await app.close();
    }
  });
});
