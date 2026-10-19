import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import { getMigrations } from "better-auth/db/migration";
import { buildApp } from "../../src/app.ts";
import { localMail } from "../../src/mail/local.ts";
import {
  authOptions,
  consumeAdministrativeAttempt,
  createAuthentication,
} from "../../src/modules/identity/index.ts";
import { browser, totp } from "../helpers/auth-client.ts";
import { withDatabase } from "../helpers/postgres.ts";

const password = "Synthetic-test-password-1234!";

test("Better Auth with real HTTP, PostgreSQL and local delivery", {
  timeout: 90000,
}, async (t) => {
  await withDatabase(async ({ root, auth, domain, migration }) => {
    const directory = path.join(root, "mail");
    const mail = localMail(directory);
    const config = {
      origin: "https://quenda.test",
      secret: randomBytes(32).toString("hex"),
    };
    const identity = createAuthentication(auth, config, mail);
    const database = {
      check: async () => {
        await auth.query("SELECT 1");
      },
      close: async () => {},
    };
    const app = await buildApp({
      database,
      domain,
      logLevel: "silent",
      identity: { authentication: identity, config },
    });
    const replica = await buildApp({
      database,
      domain,
      logLevel: "silent",
      identity: {
        authentication: createAuthentication(auth, config, mail),
        config,
      },
    });
    const link = async (
      email: string,
      kind: "verify-email" | "reset-password",
    ) => {
      const files = await readdir(directory);
      for (const filename of files) {
        const message = JSON.parse(
          await readFile(path.join(directory, filename), "utf8"),
        );
        if (message.to === email && message.text.includes(kind)) {
          assert.equal(
            (await stat(path.join(directory, filename))).mode & 0o777,
            0o600,
          );
          return new URL(message.text.trim().split("\n").at(-1));
        }
      }
      throw new Error(`Missing ${kind} mail`);
    };
    const signup = async (
      client: ReturnType<typeof browser>,
      email: string,
    ) => {
      const response = await client.request(
        "/api/auth/sign-up/email",
        {
          name: "Usuario de prueba",
          email,
          password,
          twoFactorEnabled: true,
          mfaVerifiedAt: new Date().toISOString(),
        },
        { "accept-language": "gl" },
      );
      assert.equal(response.statusCode, 200, response.body);
      return response.json().user.id as string;
    };
    const verify = async (
      client: ReturnType<typeof browser>,
      email: string,
    ) => {
      const url = await link(email, "verify-email");
      const response = await client.request(`${url.pathname}${url.search}`);
      assert.ok([200, 302].includes(response.statusCode), response.body);
    };
    try {
      await t.test(
        "authentication contract exposes only enabled routes",
        async () => {
          const response = await app.inject({
            url: "/api/auth/open-api/generate-schema",
          });
          assert.equal(response.statusCode, 200, response.body);
          const schema = response.json();
          assert.ok(schema.paths["/sign-in/email"]);
          assert.ok(schema.paths["/reset-password/{token}"]);
          assert.equal(schema.paths["/delete-user"], undefined);
          assert.equal(schema.components.securitySchemes.bearerAuth, undefined);
          assert.deepEqual(schema.paths["/sign-in/email"].post.security, []);
          assert.ok(
            schema.paths["/sign-in/email"].post.responses["401"].content[
              "application/json"
            ].schema.properties.requestId,
          );
        },
      );
      await t.test(
        "migration matches Better Auth's configured schema and runtime has no DDL or domain access",
        async () => {
          const pending = await getMigrations(
            authOptions(migration, config, mail),
          );
          assert.deepEqual(pending.toBeCreated, []);
          assert.deepEqual(pending.toBeAdded, []);
          assert.deepEqual(pending.schemaProblems, []);
          await assert.rejects(
            auth.query("CREATE TABLE auth.forbidden (id text)"),
            { code: "42501" },
          );
          await assert.rejects(domain.query('SELECT * FROM auth."user"'), {
            code: "42501",
          });
        },
      );
      await t.test(
        "verification is required; signup cannot grant MFA; session cookies are secure and logout revokes",
        async () => {
          const client = browser(app, "192.0.2.10");
          const email = "citizen@example.test";
          const id = await signup(client, email);
          assert.equal((await client.request("/api/me")).statusCode, 401);
          const denied = await client.request("/api/auth/sign-in/email", {
            email,
            password,
          });
          assert.equal(denied.statusCode, 403, denied.body);
          assert.equal(denied.json().error.code, "EMAIL_NOT_VERIFIED");
          await verify(client, email);
          const signed = await client.request("/api/auth/sign-in/email", {
            email,
            password,
          });
          assert.equal(signed.statusCode, 200, signed.body);
          const cookieHeaders = JSON.stringify(signed.headers["set-cookie"]);
          assert.match(cookieHeaders, /Secure/);
          assert.match(cookieHeaders, /HttpOnly/);
          assert.match(cookieHeaders, /SameSite=Lax/i);
          assert.deepEqual((await client.request("/api/me")).json(), {
            accountId: id,
            email,
            mfaVerified: false,
          });
          const saved = client.cookie();
          assert.equal(
            (
              await replica.inject({
                url: "/api/me",
                headers: { cookie: saved },
              })
            ).statusCode,
            200,
          );
          assert.equal(
            (await client.request("/api/auth/sign-out", {})).statusCode,
            200,
          );
          assert.equal(
            (
              await replica.inject({
                url: "/api/me",
                headers: { cookie: saved },
              })
            ).statusCode,
            401,
          );
          const persisted = await auth.query(
            'SELECT "twoFactorEnabled" FROM auth."user" WHERE id = $1',
            [id],
          );
          assert.notEqual(persisted.rows[0].twoFactorEnabled, true);
        },
      );
      await t.test(
        "password reset delivers a private link, revokes all sessions and cannot be reused",
        async () => {
          const client = browser(app, "192.0.2.20");
          const email = "recovery@example.test";
          await signup(client, email);
          await verify(client, email);
          assert.equal(
            (
              await client.request("/api/auth/sign-in/email", {
                email,
                password,
              })
            ).statusCode,
            200,
          );
          const oldCookie = client.cookie();
          assert.equal(
            (
              await client.request("/api/auth/request-password-reset", {
                email,
                redirectTo: `${config.origin}/password-reset`,
              })
            ).statusCode,
            200,
          );
          const url = await link(email, "reset-password");
          const redirect = await client.request(`${url.pathname}${url.search}`);
          // Better Auth redirects from the emailed path to the trusted callback,
          // carrying the reset token as a query parameter.
          assert.equal(redirect.statusCode, 302, redirect.body);
          const token = new URL(
            String(redirect.headers.location),
          ).searchParams.get("token");
          assert.ok(token);
          const newPassword = "New-synthetic-password-5678!";
          assert.equal(
            (
              await client.request("/api/auth/reset-password", {
                token,
                newPassword,
              })
            ).statusCode,
            200,
          );
          assert.equal(
            (
              await replica.inject({
                url: "/api/me",
                headers: { cookie: oldCookie },
              })
            ).statusCode,
            401,
          );
          assert.equal(
            (
              await client.request("/api/auth/reset-password", {
                token,
                newPassword,
              })
            ).statusCode,
            400,
          );
          assert.equal(
            (
              await client.request("/api/auth/sign-in/email", {
                email,
                password,
              })
            ).statusCode,
            401,
          );
          assert.equal(
            (
              await client.request("/api/auth/sign-in/email", {
                email,
                password: newPassword,
              })
            ).statusCode,
            200,
          );
        },
      );
      await t.test(
        "TOTP proof belongs to a session; first-factor and old sessions cannot impersonate MFA",
        async () => {
          const client = browser(app, "192.0.2.30");
          const oldDevice = browser(app, "192.0.2.31");
          const email = "municipal@example.test";
          await signup(client, email);
          await verify(client, email);
          assert.equal(
            (
              await client.request("/api/auth/sign-in/email", {
                email,
                password,
              })
            ).statusCode,
            200,
          );
          assert.equal(
            (
              await oldDevice.request("/api/auth/sign-in/email", {
                email,
                password,
              })
            ).statusCode,
            200,
          );
          const enrolled = await client.request("/api/auth/two-factor/enable", {
            password,
          });
          assert.equal(enrolled.statusCode, 200, enrolled.body);
          const backupCode = enrolled.json().backupCodes[0];
          assert.equal(typeof backupCode, "string");
          const secret = new URL(enrolled.json().totpURI).searchParams.get(
            "secret",
          );
          assert.ok(secret);
          assert.equal(
            (
              await client.request("/api/auth/two-factor/verify-totp", {
                code: totp(secret),
              })
            ).statusCode,
            200,
          );
          assert.equal(
            (await client.request("/api/me")).json().mfaVerified,
            true,
          );
          assert.equal(
            (await oldDevice.request("/api/me")).json().mfaVerified,
            false,
          );
          assert.equal(
            (await client.request("/api/auth/sign-out", {})).statusCode,
            200,
          );
          const challenge = await client.request("/api/auth/sign-in/email", {
            email,
            password,
          });
          assert.equal(challenge.statusCode, 200, challenge.body);
          assert.equal(challenge.json().twoFactorRedirect, true);
          assert.equal((await client.request("/api/me")).statusCode, 401);
          const validCodes = [-1, 0, 1].map((offset) => totp(secret, offset));
          const wrong = ["000000", "111111", "222222", "333333"].find(
            (code) => !validCodes.includes(code),
          );
          assert.equal(
            (
              await client.request("/api/auth/two-factor/verify-totp", {
                code: wrong,
              })
            ).statusCode,
            401,
          );
          assert.equal((await client.request("/api/me")).statusCode, 401);
          assert.equal(
            (
              await client.request("/api/auth/two-factor/verify-totp", {
                code: totp(secret),
              })
            ).statusCode,
            200,
          );
          assert.equal(
            (await client.request("/api/me")).json().mfaVerified,
            true,
          );
          const accountId = (await client.request("/api/me")).json().accountId;
          const migrationUrl = migration.options.connectionString;
          assert.ok(migrationUrl);
          const initialized = await promisify(execFile)(
            process.execPath,
            ["scripts/initialize-operator.ts", accountId],
            {
              env: { ...process.env, MIGRATION_DATABASE_URL: migrationUrl },
              timeout: 10000,
            },
          );
          assert.match(initialized.stdout, /First operator initialized/);
          const input = {
            name: "Municipio HTTP",
            timezone: "Europe/Madrid",
            administratorId: accountId,
            invitationExpiresAt: new Date(Date.now() + 3600000).toISOString(),
          };
          assert.equal(
            (
              await client.request("/api/municipalities", input, {
                origin: "https://evil.test",
              })
            ).statusCode,
            403,
          );
          assert.equal(
            (
              await app.inject({
                method: "POST",
                url: "/api/municipalities",
                payload: input,
                headers: { cookie: client.cookie() },
              })
            ).statusCode,
            403,
          );
          assert.equal(
            (await oldDevice.request("/api/municipalities", input)).statusCode,
            403,
          );
          assert.equal(
            (
              await client.request("/api/municipalities", {
                ...input,
                role: "operator",
              })
            ).statusCode,
            400,
          );
          await auth.query(
            `UPDATE auth.session SET "mfaVerifiedAt" = now() - interval '6 minutes' WHERE "userId" = $1 AND "mfaVerifiedAt" IS NOT NULL`,
            [accountId],
          );
          const stale = await client.request("/api/municipalities", input);
          assert.equal(stale.statusCode, 403, stale.body);
          assert.equal(stale.json().error.code, "REAUTHENTICATION_REQUIRED");
          const audited = await migration.query(
            "SELECT actor_id, requested_tenant_id, operation, outcome FROM domain.access_denial WHERE request_id=$1",
            [stale.json().requestId],
          );
          assert.deepEqual(audited.rows, [
            {
              actor_id: accountId,
              requested_tenant_id: null,
              operation: "createMunicipality",
              outcome: "REAUTHENTICATION_REQUIRED",
            },
          ]);
          assert.equal((await client.request("/api/me")).statusCode, 200);
          // Prior enrollment and login deliberately used this endpoint's real
          // three-attempt window. Let it expire; never disable the limiter.
          await setTimeout(11000);
          const failedStepUp = await client.request(
            "/api/auth/two-factor/verify-totp",
            { code: wrong },
          );
          assert.equal(failedStepUp.statusCode, 401);
          assert.equal(
            (await client.request("/api/municipalities", input)).json().error
              .code,
            "REAUTHENTICATION_REQUIRED",
          );
          const renewed = await client.request(
            "/api/auth/two-factor/verify-totp",
            { code: totp(secret) },
          );
          assert.equal(renewed.statusCode, 200, renewed.body);
          const created = await client.request("/api/municipalities", input);
          assert.equal(created.statusCode, 201, created.body);
          const { tenantId } = created.json();
          const replacement = await client.request(
            `/api/municipalities/${tenantId}/initial-administrator-invitation/replace`,
            {
              accountId,
              expiresAt: input.invitationExpiresAt,
              reason: "Reemisión de prueba",
            },
          );
          assert.equal(replacement.statusCode, 201, replacement.body);
          const { invitationId } = replacement.json();
          const own = await app.inject({
            url: "/api/me/administrator-invitations",
            headers: { cookie: client.cookie() },
          });
          assert.equal(own.statusCode, 200, own.body);
          assert.ok(
            own
              .json()
              .items.some(
                (item: { invitationId: string }) =>
                  item.invitationId === invitationId,
              ),
          );
          assert.equal(
            (
              await client.request(
                "/api/me/administrator-invitations?accountId=another",
              )
            ).statusCode,
            400,
          );
          assert.equal(
            (await app.inject({ url: "/api/me/administrator-invitations" }))
              .statusCode,
            401,
          );
          const accept = `/api/municipalities/${tenantId}/administrator-invitations/${invitationId}/accept`;
          assert.equal(
            (await client.request(accept, { accountId: "another" })).statusCode,
            400,
          );
          assert.equal((await client.request(accept, {})).statusCode, 200);
          assert.equal((await client.request(accept, {})).statusCode, 404);
          const profiles = await client.request(
            `/api/municipalities/${tenantId}/profiles`,
          );
          assert.equal(profiles.statusCode, 200, profiles.body);
          assert.deepEqual(
            profiles
              .json()
              .items.map((item: { accountId: string }) => item.accountId),
            [accountId],
          );
          assert.equal(profiles.json().nextCursor, null);
          assert.equal(
            (
              await client.request(
                `/api/municipalities/${tenantId}/profiles?accountId=another`,
              )
            ).statusCode,
            400,
          );
          const contract = app.swagger();
          assert.ok(contract.paths?.["/api/municipalities"]?.post);
          assert.ok(contract.paths?.["/api/me"]?.get);
          assert.equal(
            (
              await migration.query(
                "SELECT * FROM domain.municipal_administrator WHERE tenant_id = $1 AND account_id = $2",
                [tenantId, accountId],
              )
            ).rowCount,
            1,
          );
          const facility = await client.request(
            `/api/municipalities/${tenantId}/facilities`,
            { name: "Pabellón HTTP" },
          );
          assert.equal(facility.statusCode, 201, facility.body);
          const unit = await client.request(
            `/api/municipalities/${tenantId}/facilities/${facility.json().facilityId}/units`,
            { name: "Pista HTTP" },
          );
          assert.equal(unit.statusCode, 201, unit.body);
          assert.equal(
            (
              await migration.query(
                "SELECT name FROM domain.reservable_unit WHERE tenant_id=$1 AND id=$2",
                [tenantId, unit.json().unitId],
              )
            ).rows[0].name,
            "Pista HTTP",
          );
          assert.equal(
            (
              await client.request(
                `/api/municipalities/${tenantId}/facilities`,
                { name: "No publicar", published: true },
              )
            ).statusCode,
            400,
          );
          const delegated = await client.request(
            `/api/municipalities/${tenantId}/administrator-invitations`,
            { accountId, expiresAt: input.invitationExpiresAt },
          );
          assert.equal(delegated.statusCode, 201, delegated.body);
          const duplicateAccept = `/api/municipalities/${tenantId}/administrator-invitations/${delegated.json().invitationId}/accept`;
          assert.equal(
            (await client.request(duplicateAccept, {})).statusCode,
            409,
          );
          const revokePath = `/api/municipalities/${tenantId}/administrator-invitations/${delegated.json().invitationId}/revoke`;
          assert.equal((await client.request(revokePath, {})).statusCode, 200);
          assert.equal((await client.request(revokePath, {})).statusCode, 404);
          const managerInvitation = await client.request(
            `/api/municipalities/${tenantId}/manager-invitations`,
            {
              accountId,
              expiresAt: input.invitationExpiresAt,
              permissions: [
                { operation: "UNIT_BLOCK", unitId: unit.json().unitId },
              ],
            },
          );
          assert.equal(
            managerInvitation.statusCode,
            201,
            managerInvitation.body,
          );
          const managerPath = `/api/municipalities/${tenantId}/manager-invitations/${managerInvitation.json().invitationId}`;
          assert.equal(
            (
              await client.request(`${managerPath}/accept`, {
                permissions: [{ operation: "CATALOG_CREATE", unitId: null }],
              })
            ).statusCode,
            400,
          );
          assert.equal(
            (await client.request(`${managerPath}/accept`, {})).statusCode,
            200,
          );
          const ownManager = await client.request(
            "/api/me/manager-invitations",
          );
          assert.equal(ownManager.statusCode, 200, ownManager.body);
          assert.equal(ownManager.json().items[0].status, "ACTIVE");
          assert.equal(
            (
              await client.request(
                "/api/me/manager-invitations?accountId=other",
              )
            ).statusCode,
            400,
          );

          const updatedManager = await client.request(
            `/api/municipalities/${tenantId}/manager-invitations`,
            {
              accountId,
              expiresAt: input.invitationExpiresAt,
              replacesInvitationId: managerInvitation.json().invitationId,
              reason: "Nuevo ámbito",
              permissions: [{ operation: "CATALOG_CREATE", unitId: null }],
            },
          );
          assert.equal(updatedManager.statusCode, 201, updatedManager.body);
          const updatedManagerPath = `/api/municipalities/${tenantId}/manager-invitations/${updatedManager.json().invitationId}`;
          assert.equal(
            (await client.request(`${updatedManagerPath}/accept`, {}))
              .statusCode,
            200,
          );
          assert.equal(
            (
              await client.request(`${managerPath}/revoke`, {
                reason: "Ya sustituida",
              })
            ).statusCode,
            404,
          );
          assert.equal(
            (
              await client.request(`${updatedManagerPath}/revoke`, {
                reason: "Fin de tarea",
              })
            ).statusCode,
            200,
          );
          const removed = await client.request(
            `/api/municipalities/${tenantId}/administrators/${accountId}/revoke`,
            { reason: "Fin de función de prueba" },
          );
          assert.equal(removed.statusCode, 200, removed.body);
          assert.equal(
            (
              await client.request(
                `/api/municipalities/${tenantId}/administrator-invitations`,
                { accountId, expiresAt: input.invitationExpiresAt },
              )
            ).statusCode,
            403,
          );
          assert.equal((await client.request("/api/me")).statusCode, 200);
          for (let i = 0; i < 60; i++)
            await consumeAdministrativeAttempt(domain, accountId);
          const throttled = await replica.inject({
            method: "POST",
            url: "/api/municipalities",
            payload: input,
            headers: {
              cookie: client.cookie(),
              origin: config.origin,
              "x-forwarded-for": "198.51.100.200",
            },
          });
          assert.equal(throttled.statusCode, 429, throttled.body);
          assert.equal(throttled.json().error.code, "RATE_LIMITED");
          assert.ok(Number(throttled.headers["retry-after"]) >= 1);
          const recovery = browser(replica, "192.0.2.32");
          assert.equal(
            (
              await recovery.request("/api/auth/sign-in/email", {
                email,
                password,
              })
            ).json().twoFactorRedirect,
            true,
          );
          assert.equal(
            (
              await recovery.request(
                "/api/auth/two-factor/verify-backup-code",
                { code: backupCode },
              )
            ).statusCode,
            200,
          );
          assert.equal(
            (await recovery.request("/api/me")).json().mfaVerified,
            true,
          );
          const recoveredCookie = recovery.cookie();
          assert.equal(
            (await recovery.request("/api/auth/sign-out", {})).statusCode,
            200,
          );
          assert.equal(
            (
              await app.inject({
                url: "/api/me",
                headers: { cookie: recoveredCookie },
              })
            ).statusCode,
            401,
          );
          assert.equal(
            (
              await recovery.request("/api/auth/sign-in/email", {
                email,
                password,
              })
            ).json().twoFactorRedirect,
            true,
          );
          assert.equal(
            (
              await recovery.request(
                "/api/auth/two-factor/verify-backup-code",
                { code: backupCode },
              )
            ).statusCode,
            401,
          );
          assert.equal((await recovery.request("/api/me")).statusCode, 401);
          assert.equal(
            (await client.request("/api/auth/revoke-other-sessions", {}))
              .statusCode,
            200,
          );
          assert.equal((await oldDevice.request("/api/me")).statusCode, 401);
        },
      );
      await t.test(
        "cross-site requests and external redirects are rejected; blocked paths expose no extra features",
        async () => {
          const client = browser(app, "192.0.2.40");
          const external = await client.request(
            "/api/auth/sign-up/email",
            { name: "Test", email: "cross-site@example.test", password },
            { origin: "https://evil.test" },
          );
          assert.equal(external.statusCode, 403, external.body);
          const redirect = await client.request("/api/auth/sign-in/email", {
            email: "citizen@example.test",
            password,
            callbackURL: "https://evil.test",
          });
          assert.equal(redirect.statusCode, 403, redirect.body);
          assert.equal(
            (await client.request("/api/auth/reference")).statusCode,
            404,
          );
          assert.equal(
            (await client.request("/api/auth/delete-user", {})).statusCode,
            404,
          );
        },
      );
      await t.test(
        "rate limits are shared across replicas and cannot be bypassed with spoofed proxy headers",
        async () => {
          const clients = [
            browser(app, "192.0.2.99"),
            browser(replica, "192.0.2.99"),
          ];
          for (let i = 0; i < 4; i++) {
            const response = await clients[i % 2]?.request(
              "/api/auth/sign-in/email",
              { email: "absent@example.test", password },
              {
                "x-forwarded-for": `198.51.100.${i}`,
                "x-quenda-client-ip": `198.51.100.${i}`,
              },
            );
            assert.equal(
              response?.statusCode,
              i === 3 ? 429 : 401,
              response?.body,
            );
          }
        },
      );
    } finally {
      await Promise.all([app.close(), replica.close()]);
    }
  });
});
