import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { initializeOperator } from "../../scripts/lib/initialize-operator.ts";
import { buildApp } from "../../src/app.ts";
import { createAuthentication } from "../../src/modules/identity/auth.ts";
import type { MailMessage } from "../../src/shared/mail.ts";
import { browser, totp } from "../helpers/auth-client.ts";
import { withDatabase } from "../helpers/postgres.ts";
import { verifyProductResponses } from "../helpers/response-contract.ts";

test("privacy permission API requires verified sessions, recipient acceptance, Origin and recent MFA", {
  timeout: 60000,
}, async () => {
  await withDatabase(async ({ auth, domain, migration }) => {
    const messages: MailMessage[] = [];
    const config = {
      origin: "https://quenda.test",
      secret: randomBytes(32).toString("hex"),
    };
    const app = await buildApp({
      database: { check: async () => {}, close: async () => {} },
      domain,
      logLevel: "silent",
      identity: {
        config,
        authentication: createAuthentication(auth, config, {
          send: async (message) => {
            messages.push(message);
          },
        }),
      },
    });
    const contracts = verifyProductResponses(app);
    const password = "Synthetic-privacy-permissions-123!";
    const ok = (
      result: Awaited<ReturnType<ReturnType<typeof browser>["request"]>>,
      status = 200,
    ) => {
      assert.equal(result.statusCode, status, result.body);
      return result.json();
    };
    try {
      const register = async (name: string, ip: string) => {
        const client = browser(app, ip),
          email = `${name}@example.test`;
        const user = ok(
          await client.request("/api/auth/sign-up/email", {
            name,
            email,
            password,
          }),
        ).user;
        const message = messages.find(
          (m) => m.to === email && m.text.includes("verify-email"),
        );
        assert.ok(message);
        const url = new URL(message.text.trim().split("\n").at(-1) ?? "");
        assert.ok(
          [200, 302].includes(
            (await client.request(url.pathname + url.search)).statusCode,
          ),
        );
        ok(
          await client.request("/api/auth/sign-in/email", { email, password }),
        );
        return { client, id: user.id as string };
      };
      const enroll = async (client: ReturnType<typeof browser>) => {
        const data = ok(
          await client.request("/api/auth/two-factor/enable", { password }),
        );
        const secret = new URL(data.totpURI).searchParams.get("secret");
        assert.ok(secret);
        ok(
          await client.request("/api/auth/two-factor/verify-totp", {
            code: totp(secret),
          }),
        );
      };
      const operator = await register("privacy-operator", "192.0.2.231");
      const recipient = await register("privacy-recipient", "192.0.2.232");
      await enroll(operator.client);
      const owner = await migration.connect();
      try {
        await initializeOperator(owner, operator.id);
      } finally {
        owner.release();
      }
      const path = "/api/platform/privacy-invitations";
      const input = {
        accountId: recipient.id,
        permissions: ["PRIVACY_READ"],
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        reason: "Autorización de consulta de identidad global",
      };
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: path,
            headers: { origin: config.origin },
            payload: input,
          })
        ).statusCode,
        401,
      );
      assert.equal(
        (
          await operator.client.request(path, input, {
            origin: "https://attacker.test",
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (await recipient.client.request(path, input)).statusCode,
        403,
      );
      assert.equal(
        (
          await operator.client.request(path, {
            ...input,
            permissions: ["DATA_EXPORT"],
          })
        ).statusCode,
        400,
      );
      const invitation = ok(await operator.client.request(path, input), 201);
      const own = ok(
        await recipient.client.request("/api/me/privacy-invitations"),
      );
      assert.equal(own.items[0].invitationId, invitation.invitationId);
      assert.equal(own.items[0].status, "PENDING");
      const accept = `${path}/${invitation.invitationId}/accept`;
      assert.equal(
        (await recipient.client.request(accept, {})).statusCode,
        403,
      );
      await enroll(recipient.client);
      ok(await recipient.client.request(accept, {}));
      assert.equal(
        ok(await recipient.client.request("/api/me/privacy-invitations"))
          .items[0].status,
        "ACTIVE",
      );
      const listed = await operator.client.request(path);
      assert.equal(listed.headers["cache-control"], "no-store");
      assert.equal(ok(listed).items[0].accountId, recipient.id);
      assert.equal((await recipient.client.request(path)).statusCode, 403);
      await migration.query(
        'UPDATE auth.session SET "mfaVerifiedAt"=now()-interval \'6 minutes\' WHERE "userId"=$1',
        [recipient.id],
      );
      assert.equal(
        (await recipient.client.request(accept, {})).statusCode,
        403,
      );
      ok(
        await operator.client.request(
          `${path}/${invitation.invitationId}/revoke`,
          { reason: "Fin de autorización" },
        ),
      );
      assert.equal(
        ok(await recipient.client.request("/api/me/privacy-invitations"))
          .items[0].status,
        "REVOKED",
      );
      contracts.assertValid();
    } finally {
      await app.close();
    }
  });
});
