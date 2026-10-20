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

test("operator handover works through Better Auth email verification and real MFA without server access", {
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
    const password = "Synthetic-operator-journey-123!";
    const ok = (
      result: Awaited<ReturnType<ReturnType<typeof browser>["request"]>>,
      expected = 200,
    ) => {
      assert.equal(result.statusCode, expected, result.body);
      return result.json();
    };
    try {
      const enroll = async (client: ReturnType<typeof browser>) => {
        const enrollment = ok(
          await client.request("/api/auth/two-factor/enable", { password }),
        );
        const secret = new URL(enrollment.totpURI).searchParams.get("secret");
        assert.ok(secret);
        ok(
          await client.request("/api/auth/two-factor/verify-totp", {
            code: totp(secret),
          }),
        );
      };
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
          (value) => value.to === email && value.text.includes("verify-email"),
        );
        assert.ok(message);
        const link = new URL(message.text.trim().split("\n").at(-1) ?? "");
        assert.ok(
          [200, 302].includes(
            (await client.request(link.pathname + link.search)).statusCode,
          ),
        );
        ok(
          await client.request("/api/auth/sign-in/email", { email, password }),
        );
        return { client, id: user.id as string };
      };
      const first = await register("first-operator", "192.0.2.171");
      const second = await register("next-operator", "192.0.2.172");
      await enroll(first.client);
      const owner = await migration.connect();
      try {
        await initializeOperator(owner, first.id);
      } finally {
        owner.release();
      }
      const invitation = ok(
        await first.client.request("/api/platform/operator-invitations", {
          accountId: second.id,
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
        }),
        201,
      );
      const own = ok(
        await second.client.request("/api/me/operator-invitations"),
      );
      assert.equal(own.items[0].invitationId, invitation.invitationId);
      const acceptPath = `/api/platform/operator-invitations/${invitation.invitationId}/accept`;
      assert.equal(
        (await second.client.request(acceptPath, {})).statusCode,
        403,
      );
      await enroll(second.client);
      ok(await second.client.request(acceptPath, {}));
      ok(
        await first.client.request(
          `/api/platform/operators/${first.id}/revoke`,
          { reason: "Relevo ordinario del equipo de plataforma" },
        ),
      );
      assert.equal(
        (await first.client.request("/api/platform/operators")).statusCode,
        403,
      );
      // Losing platform authority leaves personal authentication intact.
      assert.equal(
        ok(await first.client.request("/api/auth/get-session")).user.id,
        first.id,
      );
      assert.equal(
        ok(await second.client.request("/api/platform/operators")).items.filter(
          (value: { active: boolean }) => value.active,
        ).length,
        1,
      );
      const last = await second.client.request(
        `/api/platform/operators/${second.id}/revoke`,
        { reason: "Intento sin sustituto" },
      );
      assert.equal(last.statusCode, 409, last.body);
      assert.equal(last.json().error.code, "ACCOUNT_HANDOVER_REQUIRED");
      // The database protects administrative capability even if the auth plugin
      // exposes a generic second-factor disable endpoint.
      assert.notEqual(
        (
          await second.client.request("/api/auth/two-factor/disable", {
            password,
          })
        ).statusCode,
        200,
      );
      assert.equal(
        (
          await migration.query(
            'SELECT "twoFactorEnabled" FROM auth."user" WHERE id=$1',
            [second.id],
          )
        ).rows[0].twoFactorEnabled,
        true,
      );
      contracts.assertValid();
    } finally {
      await app.close();
    }
  });
});
