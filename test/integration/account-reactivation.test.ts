import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { buildApp } from "../../src/app.ts";
import { createAuthentication } from "../../src/modules/identity/auth.ts";
import { deactivateAccount } from "../../src/modules/identity/deactivation.ts";
import type { MailMessage } from "../../src/shared/mail.ts";
import { browser, totp } from "../helpers/auth-client.ts";
import { withDatabase } from "../helpers/postgres.ts";
import { verifyProductResponses } from "../helpers/response-contract.ts";

const password = "Synthetic-reactivation-password-123!";
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

test("voluntary deactivation and reactivation require real password, mailbox and existing MFA without premature sessions", {
  timeout: 90000,
}, async (t) => {
  await withDatabase(
    async ({ auth, domain, migration, worker, administration }) => {
      const messages: MailMessage[] = [];
      const config = {
        origin: "https://quenda.test",
        secret: randomBytes(32).toString("hex"),
      };
      const identity = createAuthentication(auth, config, {
        send: async (message) => {
          messages.push(message);
        },
      });
      const app = await buildApp({
        database: { check: async () => {}, close: async () => {} },
        domain,
        identity: { authentication: identity, config },
        logLevel: "silent",
      });
      const contract = verifyProductResponses(app);
      let serial = 0;
      const signup = async (name: string, mfa = false) => {
        const client = browser(app, `192.0.2.${++serial}`);
        const email = `${name}@example.test`;
        const created = await client.request("/api/auth/sign-up/email", {
          name,
          email,
          password,
        });
        assert.equal(created.statusCode, 200, created.body);
        const id = created.json().user.id as string;
        const verification = messages.find(
          (message) =>
            message.to === email && message.text.includes("/verify-email"),
        );
        assert.ok(verification);
        const url = new URL(verification.text.trim().split("\n").at(-1) ?? "");
        assert.ok(
          [200, 302].includes(
            (await client.request(url.pathname + url.search)).statusCode,
          ),
        );
        const signed = await client.request("/api/auth/sign-in/email", {
          email,
          password,
        });
        assert.equal(signed.statusCode, 200, signed.body);
        let secret: string | null = null;
        let backupCodes: string[] = [];
        if (mfa) {
          const enabled = await client.request("/api/auth/two-factor/enable", {
            password,
          });
          assert.equal(enabled.statusCode, 200, enabled.body);
          backupCodes = enabled.json().backupCodes;
          secret = new URL(enabled.json().totpURI).searchParams.get("secret");
          assert.ok(secret);
          const verified = await client.request(
            "/api/auth/two-factor/verify-totp",
            { code: totp(secret) },
          );
          assert.equal(verified.statusCode, 200, verified.body);
        }
        return { id, email, client, secret, backupCodes };
      };
      const requestLink = async (entry: Awaited<ReturnType<typeof signup>>) => {
        const before = messages.length;
        const response = await entry.client.request(
          "/api/account/reactivation/request",
          { email: entry.email, password },
        );
        assert.equal(response.statusCode, 202, response.body);
        const message = messages
          .slice(before)
          .find((m) => m.to === entry.email);
        assert.ok(message, "Missing reactivation email");
        const url = new URL(message.text.trim().split("\n").at(-1) ?? "");
        assert.equal(url.origin, config.origin);
        assert.equal(url.search, "");
        const token = url.hash.slice(1);
        assert.match(token, /^[A-Za-z0-9_-]{43}$/);
        return token;
      };
      const deactivate = async (entry: Awaited<ReturnType<typeof signup>>) => {
        const response = await entry.client.request("/api/me/deactivation", {
          confirm: true,
          password,
        });
        assert.equal(response.statusCode, 200, response.body);
      };
      const sessionCount = async (id: string) =>
        (
          await migration.query(
            'SELECT count(*)::int AS n FROM auth.session WHERE "userId"=$1',
            [id],
          )
        ).rows[0].n as number;
      try {
        await t.test(
          "password is mandatory for deactivation; reactivation is one-use, restores no sessions and requires normal login",
          async () => {
            const entry = await signup("reactivation");
            assert.equal(
              (
                await entry.client.request("/api/me/deactivation", {
                  confirm: true,
                })
              ).statusCode,
              400,
            );
            const wrong = await entry.client.request("/api/me/deactivation", {
              confirm: true,
              password: "Incorrect-password-123!",
            });
            assert.equal(wrong.statusCode, 403, wrong.body);
            assert.equal(await sessionCount(entry.id), 1);
            await deactivate(entry);
            const staleCookie = entry.client.cookie();
            const token = await requestLink(entry);
            const challenge = (
              await migration.query(
                "SELECT token_digest,extract(epoch FROM expires_at-created_at)::int AS lifetime FROM auth.account_reactivation_challenge WHERE account_id=$1",
                [entry.id],
              )
            ).rows[0];
            assert.equal(challenge.token_digest, hash(token));
            assert.equal(challenge.lifetime, 600);
            assert.equal(await sessionCount(entry.id), 0);
            const bad = await entry.client.request(
              "/api/account/reactivation/confirm",
              { token, password: "Incorrect-password-123!" },
            );
            assert.equal(bad.statusCode, 400, bad.body);
            assert.equal(await sessionCount(entry.id), 0);
            const confirmed = await entry.client.request(
              "/api/account/reactivation/confirm",
              { token, password },
            );
            assert.equal(confirmed.statusCode, 200, confirmed.body);
            assert.equal(confirmed.json().status, "REACTIVATED");
            assert.equal(confirmed.headers["set-cookie"], undefined);
            assert.equal(await sessionCount(entry.id), 0);
            assert.equal(
              (
                await app.inject({
                  url: "/api/me",
                  headers: { cookie: staleCookie },
                })
              ).statusCode,
              401,
            );
            assert.equal(
              (
                await entry.client.request(
                  "/api/account/reactivation/confirm",
                  {
                    token,
                    password,
                  },
                )
              ).statusCode,
              400,
            );
            assert.equal(
              (
                await migration.query(
                  "SELECT count(*)::int AS n FROM auth.account_reactivation_event WHERE subject_id=$1",
                  [entry.id],
                )
              ).rows[0].n,
              1,
            );
            const login = await entry.client.request(
              "/api/auth/sign-in/email",
              {
                email: entry.email,
                password,
              },
            );
            assert.equal(login.statusCode, 200, login.body);
            await deactivate(entry);
            assert.equal(
              (
                await migration.query(
                  "SELECT count(*)::int AS n FROM auth.account_deactivation_event WHERE subject_id=$1",
                  [entry.id],
                )
              ).rows[0].n,
              2,
            );
            assert.equal(
              (
                await entry.client.request(
                  "/api/account/reactivation/confirm",
                  {
                    token,
                    password,
                  },
                )
              ).statusCode,
              400,
            );
          },
        );

        await t.test(
          "MFA-enabled accounts require a fresh proof for deactivation and the existing TOTP for reactivation",
          async () => {
            const entry = await signup("reactivation-mfa", true);
            assert.ok(entry.secret);
            await migration.query(
              'UPDATE auth.session SET "mfaVerifiedAt"=now()-interval \'5 minutes\' WHERE "userId"=$1',
              [entry.id],
            );
            const stale = await entry.client.request("/api/me/deactivation", {
              confirm: true,
              password,
            });
            assert.equal(stale.statusCode, 403, stale.body);
            assert.equal(stale.json().error.code, "REAUTHENTICATION_REQUIRED");
            const fresh = await entry.client.request(
              "/api/auth/two-factor/verify-totp",
              { code: totp(entry.secret) },
            );
            assert.equal(fresh.statusCode, 200, fresh.body);
            await migration.query(
              `INSERT INTO auth."user"(id,name,email,"emailVerified","twoFactorEnabled","updatedAt")
             VALUES('retained-operator','Retained operator','retained-operator@example.test',true,true,now())`,
            );
            await migration.query(
              "INSERT INTO domain.platform_operator(account_id) VALUES($1),('retained-operator')",
              [entry.id],
            );
            await deactivate(entry);
            const token = await requestLink(entry);
            for (const body of [
              { token, password },
              { token, password, totpCode: totp(entry.secret, -10) },
            ]) {
              const response = await entry.client.request(
                "/api/account/reactivation/confirm",
                body,
              );
              assert.equal(response.statusCode, 400, response.body);
            }
            assert.equal(await sessionCount(entry.id), 0);
            const confirmed = await entry.client.request(
              "/api/account/reactivation/confirm",
              { token, password, totpCode: totp(entry.secret) },
            );
            assert.equal(confirmed.statusCode, 200, confirmed.body);
            assert.equal(await sessionCount(entry.id), 0);
            assert.ok(
              (
                await migration.query(
                  "SELECT revoked_at FROM domain.platform_operator WHERE account_id=$1",
                  [entry.id],
                )
              ).rows[0].revoked_at,
              "Reactivation must not restore the former operator role",
            );
            assert.equal(
              (
                await migration.query(
                  'SELECT "twoFactorEnabled" FROM auth."user" WHERE id=$1',
                  [entry.id],
                )
              ).rows[0].twoFactorEnabled,
              true,
            );
          },
        );

        await t.test(
          "concurrent confirmations produce exactly one reactivation event",
          async () => {
            const entry = await signup("reactivation-concurrent");
            await deactivate(entry);
            const token = await requestLink(entry);
            const responses = await Promise.all(
              [1, 2].map(() =>
                entry.client.request("/api/account/reactivation/confirm", {
                  token,
                  password,
                }),
              ),
            );
            assert.deepEqual(
              responses.map((r) => r.statusCode).sort(),
              [200, 400],
            );
            assert.equal(await sessionCount(entry.id), 0);
            assert.equal(
              (
                await migration.query(
                  "SELECT count(*)::int AS n FROM auth.account_reactivation_event WHERE subject_id=$1",
                  [entry.id],
                )
              ).rows[0].n,
              1,
            );
          },
        );

        await t.test(
          "expired tokens and a suspension applied after issue cannot reactivate; unknown and wrong-password requests do not enumerate accounts",
          async () => {
            const entry = await signup("reactivation-expired");
            const before = messages.length;
            for (const email of [entry.email, "missing@example.test"]) {
              const response = await entry.client.request(
                "/api/account/reactivation/request",
                { email, password },
              );
              assert.equal(response.statusCode, 202, response.body);
            }
            assert.equal(messages.length, before);
            await deactivate(entry);
            const bad = await entry.client.request(
              "/api/account/reactivation/request",
              { email: entry.email, password: "Wrong-password-123!" },
            );
            assert.equal(bad.statusCode, 202, bad.body);
            assert.equal(messages.length, before);
            const expired = await requestLink(entry);
            await migration.query(
              "UPDATE auth.account_reactivation_challenge SET created_at=now()-interval '11 minutes',expires_at=now()-interval '1 minute' WHERE token_digest=$1",
              [hash(expired)],
            );
            assert.equal(
              (
                await entry.client.request(
                  "/api/account/reactivation/confirm",
                  {
                    token: expired,
                    password,
                  },
                )
              ).statusCode,
              400,
            );
            const token = await requestLink(entry);
            await migration.query(
              "UPDATE auth.account_lifecycle SET suspended_at=clock_timestamp() WHERE account_id=$1",
              [entry.id],
            );
            assert.equal(
              (
                await entry.client.request(
                  "/api/account/reactivation/confirm",
                  {
                    token,
                    password,
                  },
                )
              ).statusCode,
              400,
            );
            assert.equal(await sessionCount(entry.id), 0);
            for (const pool of [domain, worker]) {
              await assert.rejects(
                pool.query(
                  "SELECT auth.complete_account_reactivation($1,$2,$3)",
                  [hash(token), entry.id, randomUUID()],
                ),
                { code: "42501" },
              );
            }
          },
        );

        await t.test(
          "failed MFA attempts are bounded across newly issued tokens",
          async () => {
            const entry = await signup("reactivation-budget", true);
            assert.ok(entry.secret);
            await deactivate(entry);
            const first = await requestLink(entry);
            const second = await requestLink(entry);
            for (let attempt = 0; attempt < 5; attempt++) {
              const response = await entry.client.request(
                "/api/account/reactivation/confirm",
                { token: first, password, totpCode: totp(entry.secret, -10) },
              );
              assert.equal(response.statusCode, 400, response.body);
            }
            const rejected = await entry.client.request(
              "/api/account/reactivation/confirm",
              { token: second, password, totpCode: totp(entry.secret) },
            );
            assert.equal(rejected.statusCode, 429, rejected.body);
            assert.equal(await sessionCount(entry.id), 0);
            assert.equal(
              (
                await migration.query(
                  "SELECT attempts FROM auth.account_reactivation_challenge WHERE token_digest=$1",
                  [hash(first)],
                )
              ).rows[0].attempts,
              5,
            );
          },
        );

        await t.test(
          "audit failure rolls back reactivation and token consumption",
          async () => {
            const entry = await signup("reactivation-audit");
            await deactivate(entry);
            const token = await requestLink(entry);
            await migration.query(
              "CREATE FUNCTION auth.reject_reactivation_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic audit failure'; END $$; CREATE TRIGGER reject_reactivation_audit BEFORE INSERT ON auth.account_reactivation_event FOR EACH ROW EXECUTE FUNCTION auth.reject_reactivation_audit()",
            );
            try {
              const response = await entry.client.request(
                "/api/account/reactivation/confirm",
                { token, password },
              );
              assert.equal(response.statusCode, 500, response.body);
              const retained = (
                await migration.query(
                  "SELECT l.deactivated_at,c.consumed_at FROM auth.account_lifecycle l JOIN auth.account_reactivation_challenge c ON c.account_id=l.account_id WHERE c.token_digest=$1",
                  [hash(token)],
                )
              ).rows[0];
              assert.ok(retained.deactivated_at);
              assert.equal(retained.consumed_at, null);
              assert.equal(await sessionCount(entry.id), 0);
            } finally {
              await migration.query(
                "DROP TRIGGER reject_reactivation_audit ON auth.account_reactivation_event; DROP FUNCTION auth.reject_reactivation_audit()",
              );
            }
            const retry = await entry.client.request(
              "/api/account/reactivation/confirm",
              { token, password },
            );
            assert.equal(retry.statusCode, 200, retry.body);
          },
        );

        await t.test(
          "a suspension committing before a waiting confirmation cannot be bypassed by a stale snapshot",
          async () => {
            const entry = await signup("reactivation-suspension-race");
            await deactivate(entry);
            const token = await requestLink(entry);
            const gate = await migration.connect();
            let confirming: ReturnType<typeof entry.client.request> | undefined;
            try {
              await gate.query("BEGIN");
              await gate.query(
                "UPDATE auth.account_lifecycle SET suspended_at=clock_timestamp() WHERE account_id=$1",
                [entry.id],
              );
              confirming = entry.client.request(
                "/api/account/reactivation/confirm",
                { token, password },
              );
              let waiting = false;
              for (let attempt = 0; attempt < 100; attempt++) {
                const result = await administration.query(
                  "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT auth.lock_reactivation_account%'",
                );
                if (result.rowCount) {
                  waiting = true;
                  break;
                }
                await setTimeout(20);
              }
              assert.ok(
                waiting,
                "Confirmation must acquire the lifecycle lock",
              );
              await gate.query("COMMIT");
              const rejected = await confirming;
              assert.equal(rejected.statusCode, 400, rejected.body);
              assert.equal(await sessionCount(entry.id), 0);
              assert.equal(
                (
                  await migration.query(
                    "SELECT count(*)::int AS n FROM auth.account_reactivation_event WHERE subject_id=$1",
                    [entry.id],
                  )
                ).rows[0].n,
                0,
              );
            } finally {
              await gate.query("ROLLBACK");
              gate.release();
              if (confirming) await confirming;
            }
          },
        );

        await t.test(
          "existing MFA backup codes are consumed once and consumption failure rolls back the entire reactivation",
          async () => {
            const entry = await signup("reactivation-backup", true);
            const [firstCode, secondCode, thirdCode] = entry.backupCodes;
            assert.ok(firstCode && secondCode && thirdCode);
            await deactivate(entry);
            const token = await requestLink(entry);
            const oldCodes = (
              await migration.query(
                'SELECT "backupCodes" FROM auth."twoFactor" WHERE "userId"=$1',
                [entry.id],
              )
            ).rows[0].backupCodes;
            await migration.query(
              `CREATE FUNCTION auth.reject_reactivation_backup() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."backupCodes" IS DISTINCT FROM OLD."backupCodes" THEN RAISE EXCEPTION 'Synthetic MFA consumption failure'; END IF; RETURN NEW; END $$;
               CREATE TRIGGER reject_reactivation_backup BEFORE UPDATE ON auth."twoFactor" FOR EACH ROW EXECUTE FUNCTION auth.reject_reactivation_backup()`,
            );
            try {
              const failed = await entry.client.request(
                "/api/account/reactivation/confirm",
                { token, password, backupCode: firstCode },
              );
              assert.equal(failed.statusCode, 500, failed.body);
              const retained = (
                await migration.query(
                  'SELECT l.deactivated_at,c.consumed_at,f."backupCodes" FROM auth.account_lifecycle l JOIN auth.account_reactivation_challenge c ON c.account_id=l.account_id JOIN auth."twoFactor" f ON f."userId"=l.account_id WHERE c.token_digest=$1',
                  [hash(token)],
                )
              ).rows[0];
              assert.ok(retained.deactivated_at);
              assert.equal(retained.consumed_at, null);
              assert.equal(retained.backupCodes, oldCodes);
              assert.equal(await sessionCount(entry.id), 0);
            } finally {
              await migration.query(
                'DROP TRIGGER reject_reactivation_backup ON auth."twoFactor"; DROP FUNCTION auth.reject_reactivation_backup()',
              );
            }
            const success = await entry.client.request(
              "/api/account/reactivation/confirm",
              { token, password, backupCode: firstCode },
            );
            assert.equal(success.statusCode, 200, success.body);
            assert.equal(await sessionCount(entry.id), 0);
            const signin = await entry.client.request(
              "/api/auth/sign-in/email",
              { email: entry.email, password },
            );
            assert.equal(signin.statusCode, 200, signin.body);
            assert.equal(signin.json().twoFactorRedirect, true);
            const reused = await entry.client.request(
              "/api/auth/two-factor/verify-backup-code",
              { code: firstCode },
            );
            assert.equal(reused.statusCode, 401, reused.body);
            const mfa = await entry.client.request(
              "/api/auth/two-factor/verify-backup-code",
              { code: secondCode },
            );
            assert.equal(mfa.statusCode, 200, mfa.body);
            await deactivate(entry);
            const freshToken = await requestLink(entry);
            for (const used of [firstCode, secondCode]) {
              const invalid = await entry.client.request(
                "/api/account/reactivation/confirm",
                { token: freshToken, password, backupCode: used },
              );
              assert.equal(invalid.statusCode, 400, invalid.body);
            }
            const fresh = await entry.client.request(
              "/api/account/reactivation/confirm",
              { token: freshToken, password, backupCode: thirdCode },
            );
            assert.equal(fresh.statusCode, 200, fresh.body);
            assert.equal(await sessionCount(entry.id), 0);
          },
        );

        await t.test(
          "password change invalidates a previously issued deactivation proof",
          async () => {
            const entry = await signup("deactivation-proof");
            const headers = new Headers({
              origin: config.origin,
              cookie: entry.client.cookie(),
            });
            const actor = await identity.authenticate(headers);
            assert.ok(actor);
            const proof = await identity.verifyDeactivation(headers, password);
            const changed = await entry.client.request(
              "/api/auth/change-password",
              {
                currentPassword: password,
                newPassword: "Replacement-synthetic-password-123!",
              },
            );
            assert.equal(changed.statusCode, 200, changed.body);
            await assert.rejects(
              deactivateAccount(domain, actor, randomUUID(), hash(proof)),
              { code: "ACCOUNT_PASSWORD_REQUIRED" },
            );
            assert.equal(
              (
                await migration.query(
                  "SELECT deactivated_at FROM auth.account_lifecycle WHERE account_id=$1",
                  [entry.id],
                )
              ).rows[0].deactivated_at,
              null,
            );
          },
        );
        contract.assertValid();
      } finally {
        await app.close();
      }
    },
  );
});
