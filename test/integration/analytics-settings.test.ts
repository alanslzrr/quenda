import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { buildApp } from "../../src/app.ts";
import { createAuthentication } from "../../src/modules/identity/index.ts";
import {
  acceptManager,
  inviteManager,
} from "../../src/modules/identity/manager.ts";
import { browser, totp } from "../helpers/auth-client.ts";
import { withDatabase } from "../helpers/postgres.ts";
import { verifyProductResponses } from "../helpers/response-contract.ts";
import { seedMunicipalBrowser } from "../helpers/web-municipal.ts";

test("analytics settings are read by report readers and changed only by the administrator with audit", {
  timeout: 60000,
}, async () => {
  await withDatabase(async ({ auth, domain, migration }) => {
    const config = {
      origin: "http://127.0.0.1:5173",
      secret: randomBytes(32).toString("hex"),
    };
    const app = await buildApp({
      database: { check: async () => {}, close: async () => {} },
      domain,
      logLevel: "silent",
      identity: {
        config,
        authentication: createAuthentication(auth, config, {
          send: async () => {},
        }),
      },
    });
    const contract = verifyProductResponses(app);
    try {
      const f = await seedMunicipalBrowser(app, auth, domain, migration, 1);
      const reader = await seedMunicipalBrowser(
        app,
        auth,
        domain,
        migration,
        2,
      );
      const signIn = async (
        account: { email: string; password: string; secret: string },
        ip: string,
        mfa = true,
      ) => {
        const client = browser(app, ip, config.origin);
        await client.request("/api/auth/sign-in/email", {
          email: account.email,
          password: account.password,
        });
        if (mfa)
          await client.request("/api/auth/two-factor/verify-totp", {
            code: totp(account.secret),
          });
        return client;
      };
      const path = `/api/municipalities/${f.tenant}/analytics/settings`;
      const put = (
        client: ReturnType<typeof browser>,
        payload: Record<string, unknown>,
        url = path,
      ) =>
        app.inject({
          method: "PUT",
          url,
          remoteAddress: "192.0.2.179",
          headers: { origin: config.origin, cookie: client.cookie() },
          payload,
        });
      const admin = await signIn(f, "192.0.2.170");
      const body = {
        expectedVersion: 1,
        highDemandPercent: 90,
        lowUsePercent: 25,
        defaultPeriod: "LAST_30_DAYS",
      };

      await test("defaults apply until the administrator changes them", async () => {
        const response = await admin.request(path);
        assert.equal(response.statusCode, 200, response.body);
        assert.equal(response.headers["cache-control"], "no-store");
        assert.deepEqual(response.json(), {
          version: 1,
          highDemandPercent: 85,
          lowUsePercent: 20,
          defaultPeriod: "THIS_MONTH",
        });
      });

      await test("invalid thresholds and periods are refused without changes", async () => {
        for (const invalid of [
          { ...body, lowUsePercent: 90 },
          { ...body, lowUsePercent: 95 },
          { ...body, highDemandPercent: 100 },
          { ...body, lowUsePercent: 0 },
          { ...body, highDemandPercent: 50.5 },
          { ...body, defaultPeriod: "LAST_YEAR" },
        ])
          assert.equal(
            (await put(admin, invalid)).statusCode,
            400,
            JSON.stringify(invalid),
          );
        assert.equal((await admin.request(path)).json().version, 1);
      });

      await test("a save is versioned and records the previous and next values", async () => {
        const saved = await put(admin, body);
        assert.equal(saved.statusCode, 200, saved.body);
        assert.deepEqual(saved.json(), {
          version: 2,
          highDemandPercent: 90,
          lowUsePercent: 25,
          defaultPeriod: "LAST_30_DAYS",
        });
        assert.equal((await put(admin, body)).statusCode, 409);
        const events = await migration.query(
          "SELECT actor_id,version,previous_state,next_state FROM domain.municipal_analytics_event WHERE tenant_id=$1",
          [f.tenant],
        );
        assert.deepEqual(events.rows, [
          {
            actor_id: f.accountId,
            version: 2,
            previous_state: {
              highDemandPercent: 85,
              lowUsePercent: 20,
              defaultPeriod: "THIS_MONTH",
            },
            next_state: {
              highDemandPercent: 90,
              lowUsePercent: 25,
              defaultPeriod: "LAST_30_DAYS",
            },
          },
        ]);
      });

      await test("other municipalities and accounts without report authority cannot read or write", async () => {
        const outsider = await signIn(reader, "192.0.2.171");
        assert.equal((await outsider.request(path)).statusCode, 403);
        assert.equal(
          (await put(outsider, { ...body, expectedVersion: 2 })).statusCode,
          403,
        );
        const own = await outsider.request(
          `/api/municipalities/${reader.tenant}/analytics/settings`,
        );
        assert.equal(own.json().version, 1);
      });

      await test("report authority over one unit reads the settings but cannot change them", async () => {
        const actor = (account: { accountId: string; email: string }) => ({
          accountId: account.accountId,
          email: account.email,
          sessionId: "synthetic",
          mfaVerifiedAt: new Date(),
        });
        const invitation = await inviteManager(domain, actor(f), f.tenant, {
          email: reader.email,
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
          permissions: [{ operation: "REPORT_READ", unitId: f.unit }],
        });
        await acceptManager(
          domain,
          actor(reader),
          f.tenant,
          invitation.invitationId,
        );
        const limited = await signIn(reader, "192.0.2.172");
        const read = await limited.request(path);
        assert.equal(read.statusCode, 200, read.body);
        assert.equal(read.json().highDemandPercent, 90);
        assert.equal(
          (await put(limited, { ...body, expectedVersion: 2 })).statusCode,
          403,
        );
      });

      await test("a session without MFA is refused", async () => {
        const plain = await signIn(f, "192.0.2.173", false);
        assert.ok([401, 403].includes((await plain.request(path)).statusCode));
        assert.ok(
          [401, 403].includes(
            (await put(plain, { ...body, expectedVersion: 2 })).statusCode,
          ),
        );
      });
      contract.assertValid();
    } finally {
      await app.close();
    }
  });
});
