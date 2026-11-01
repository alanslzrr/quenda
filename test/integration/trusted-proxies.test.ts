import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { buildApp } from "../../src/app.ts";
import { createAuthentication } from "../../src/modules/identity/index.ts";
import { withDatabase } from "../helpers/postgres.ts";

test("trusted proxies partition real authentication and public limits without trusting forged hops or origins", {
  timeout: 60000,
}, async () => {
  await withDatabase(async ({ auth, domain }) => {
    const config = {
      origin: "https://quenda.test",
      secret: randomBytes(32).toString("hex"),
    };
    const authentication = createAuthentication(auth, config, {
      send: async () => {},
    });
    const make = () =>
      buildApp({
        trustedProxyCidrs: ["127.0.0.1/32"],
        domain,
        logLevel: "silent",
        database: { check: async () => {}, close: async () => {} },
        identity: { authentication, config },
      });
    const apps = await Promise.all([make(), make()]);
    const login = (
      index: number,
      peer: string,
      forwarded: string,
      origin = config.origin,
    ) =>
      apps[index % 2 === 0 ? 0 : 1].inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        remoteAddress: peer,
        headers: {
          origin,
          "x-forwarded-for": forwarded,
          "x-quenda-client-ip": "203.0.113.99",
          "x-forwarded-host": "forged.example",
          "x-forwarded-proto": "http",
        },
        payload: {
          email: "absent@example.test",
          password: "Synthetic-password-1234!",
        },
      });
    try {
      for (let i = 0; i < 4; i++) {
        const response = await login(
          i,
          "127.0.0.1",
          `198.51.100.${i}, 192.0.2.10`,
        );
        assert.equal(response.statusCode, i < 3 ? 401 : 429, response.body);
      }
      assert.equal((await login(0, "127.0.0.1", "192.0.2.11")).statusCode, 401);
      assert.equal(
        (await login(1, "127.0.0.1", "192.0.2.12", "https://forged.example"))
          .statusCode,
        403,
      );
      for (let i = 0; i < 4; i++) {
        const response = await login(i, "192.0.2.50", `198.51.100.${i}`);
        assert.equal(response.statusCode, i < 3 ? 401 : 429, response.body);
      }
      const url = `/api/public/municipalities/${randomUUID()}/facilities`;
      for (let i = 0; i < 61; i++) {
        const response = await apps[i % 2 === 0 ? 0 : 1].inject({
          url,
          remoteAddress: "127.0.0.1",
          headers: { "x-forwarded-for": `198.51.100.${i}, 192.0.2.10` },
        });
        assert.equal(response.statusCode, i < 60 ? 200 : 429, response.body);
      }
      assert.equal(
        (
          await apps[0].inject({
            url,
            remoteAddress: "127.0.0.1",
            headers: { "x-forwarded-for": "192.0.2.11" },
          })
        ).statusCode,
        200,
      );
      assert.equal(
        (
          await apps[0].inject({
            url,
            remoteAddress: "192.0.2.51",
            headers: { "x-forwarded-for": "192.0.2.10" },
          })
        ).statusCode,
        200,
      );
    } finally {
      await Promise.all(apps.map((app) => app.close()));
    }
  });
});
