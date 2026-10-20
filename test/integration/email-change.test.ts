import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { recoverEmail } from "../../scripts/lib/recover-email.ts";
import { buildApp } from "../../src/app.ts";
import {
  authOptions,
  createAuthentication,
} from "../../src/modules/identity/auth.ts";
import type { MailMessage } from "../../src/shared/mail.ts";
import { browser, totp } from "../helpers/auth-client.ts";
import { withDatabase } from "../helpers/postgres.ts";
import { verifyProductResponses } from "../helpers/response-contract.ts";

const password = "Synthetic-email-change-password-123!";
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
test("email change requires current credentials and both mailboxes without premature identity changes", {
  timeout: 90000,
}, async (t) => {
  await withDatabase(
    async ({ auth, domain, migration, worker, administration }) => {
      const messages: MailMessage[] = [];
      let failDelivery = false;
      const mail = {
        send: async (message: MailMessage) => {
          if (failDelivery) throw new Error("Synthetic delivery failure");
          messages.push(message);
        },
      };
      const config = {
        origin: "https://quenda.test",
        secret: randomBytes(32).toString("hex"),
      };
      const identity = createAuthentication(auth, config, mail);
      const app = await buildApp({
        database: { check: async () => {}, close: async () => {} },
        domain,
        identity: { authentication: identity, config },
        logLevel: "silent",
      });
      const contract = verifyProductResponses(app);
      let serial = 0;
      const signup = async (name: string, mfa = false) => {
        const client = browser(app, `192.0.2.${++serial}`),
          email = `${name}@example.test`;
        const result = await client.request("/api/auth/sign-up/email", {
          name,
          email,
          password,
        });
        assert.equal(result.statusCode, 200, result.body);
        const id = result.json().user.id as string;
        const message = messages.find(
          (m) => m.to === email && m.text.includes("/verify-email"),
        );
        assert.ok(message);
        const url = new URL(message.text.trim().split("\n").at(-1) ?? "");
        assert.ok(
          [200, 302].includes(
            (await client.request(url.pathname + url.search)).statusCode,
          ),
        );
        assert.equal(
          (await client.request("/api/auth/sign-in/email", { email, password }))
            .statusCode,
          200,
        );
        let secret: string | null = null;
        if (mfa) {
          const enabled = await client.request("/api/auth/two-factor/enable", {
            password,
          });
          assert.equal(enabled.statusCode, 200, enabled.body);
          secret = new URL(enabled.json().totpURI).searchParams.get("secret");
          assert.ok(secret);
          assert.equal(
            (
              await client.request("/api/auth/two-factor/verify-totp", {
                code: totp(secret),
              })
            ).statusCode,
            200,
          );
        }
        return { id, email, client, secret };
      };
      const lastToken = (email: string, step: "approve" | "confirm") => {
        const message = messages.findLast(
          (m) => m.to === email && m.text.includes(`/email-change/${step}`),
        );
        assert.ok(message);
        const url = new URL(message.text.trim().split("\n").at(-1) ?? "");
        assert.equal(url.origin, config.origin);
        assert.equal(url.search, "");
        assert.match(url.hash.slice(1), /^[A-Za-z0-9_-]{43}$/);
        return url.hash.slice(1);
      };
      const request = async (
        entry: Awaited<ReturnType<typeof signup>>,
        newEmail: string,
      ) => {
        const response = await entry.client.request(
          "/api/me/email-change/request",
          { newEmail, password },
        );
        assert.equal(response.statusCode, 202, response.body);
        return lastToken(entry.email, "approve");
      };
      const approve = async (
        entry: Awaited<ReturnType<typeof signup>>,
        newEmail: string,
        token: string,
      ) => {
        const response = await entry.client.request(
          "/api/me/email-change/approve",
          { token },
        );
        assert.equal(response.statusCode, 202, response.body);
        return lastToken(newEmail, "confirm");
      };
      const emailOf = async (id: string) =>
        (
          await migration.query('SELECT email FROM auth."user" WHERE id=$1', [
            id,
          ])
        ).rows[0].email as string;
      try {
        await t.test(
          "password, same-origin POST, old mailbox before new mailbox, session revocation and reset invalidation",
          async () => {
            const entry = await signup("email-normal"),
              newEmail = "email-normal-new@example.test";
            assert.equal(
              (
                await entry.client.request("/api/auth/change-email", {
                  newEmail,
                })
              ).statusCode,
              404,
            );
            assert.equal(
              (
                await entry.client.request("/api/me/email-change/request", {
                  newEmail,
                  password: "Wrong-password-123!",
                })
              ).statusCode,
              403,
            );
            assert.equal(
              (
                await entry.client.request(
                  "/api/me/email-change/request",
                  { newEmail, password },
                  { origin: "https://attacker.test" },
                )
              ).statusCode,
              403,
            );
            const approval = await request(entry, newEmail);
            assert.equal(await emailOf(entry.id), entry.email);
            assert.equal(
              messages.some((m) => m.to === newEmail),
              false,
            );
            assert.equal(
              (
                await entry.client.request(
                  `/api/me/email-change/approve?token=${approval}`,
                )
              ).statusCode,
              404,
            );
            const wrongStep = await entry.client.request(
              "/api/me/email-change/confirm",
              { token: approval },
            );
            assert.equal(wrongStep.statusCode, 400, wrongStep.body);
            const verification = await approve(entry, newEmail, approval);
            assert.equal(await emailOf(entry.id), entry.email);
            assert.equal(
              (
                await entry.client.request("/api/me/email-change/approve", {
                  token: approval,
                })
              ).statusCode,
              400,
            );
            await entry.client.request("/api/auth/request-password-reset", {
              email: entry.email,
            });
            const resets = await migration.query(
              "SELECT identifier FROM auth.verification WHERE value=$1",
              [entry.id],
            );
            assert.ok(resets.rowCount);
            const secondSession = browser(app, `192.0.2.${++serial}`);
            await secondSession.request("/api/auth/sign-in/email", {
              email: entry.email,
              password,
            });
            assert.equal(
              (
                await secondSession.request("/api/me/email-change/confirm", {
                  token: verification,
                })
              ).statusCode,
              400,
            );
            const confirmation = await entry.client.request(
              "/api/me/email-change/confirm",
              { token: verification },
            );
            assert.equal(confirmation.statusCode, 200, confirmation.body);
            assert.equal(confirmation.json().status, "EMAIL_CHANGED");
            assert.equal(confirmation.headers["set-cookie"], undefined);
            assert.equal(await emailOf(entry.id), newEmail);
            assert.equal(
              (
                await migration.query(
                  'SELECT count(*)::int n FROM auth.session WHERE "userId"=$1',
                  [entry.id],
                )
              ).rows[0].n,
              0,
            );
            assert.equal(
              (
                await migration.query(
                  "SELECT count(*)::int n FROM auth.verification WHERE value=$1",
                  [entry.id],
                )
              ).rows[0].n,
              0,
            );
            assert.equal(
              (await entry.client.request("/api/me")).statusCode,
              401,
            );
            assert.equal(
              (await secondSession.request("/api/me")).statusCode,
              401,
            );
            const signed = await entry.client.request(
              "/api/auth/sign-in/email",
              { email: newEmail, password },
            );
            assert.equal(signed.statusCode, 200, signed.body);
            assert.equal(signed.json().user.id, entry.id);
            // Simulate BA having read the old user before the email change, then
            // inserting a reset token after the change's transaction committed.
            const staleReset = randomUUID();
            await migration.query(
              `INSERT INTO auth.verification(id,identifier,value,"expiresAt","createdAt","updatedAt")
             VALUES($1,$2,$3,now()+interval '1 hour',now(),now())`,
              [randomUUID(), `reset-password:${staleReset}`, entry.id],
            );
            const sentBefore = messages.length;
            await authOptions(
              auth,
              config,
              mail,
            ).emailAndPassword.sendResetPassword({
              user: { id: entry.id, email: entry.email },
              url: `${config.origin}/reset-password/${staleReset}`,
              token: staleReset,
            });
            assert.equal(messages.length, sentBefore);
            assert.equal(
              (
                await migration.query(
                  "SELECT 1 FROM auth.verification WHERE identifier=$1",
                  [`reset-password:${staleReset}`],
                )
              ).rowCount,
              0,
            );
            assert.equal(
              (
                await entry.client.request("/api/me/email-change/confirm", {
                  token: verification,
                })
              ).statusCode,
              400,
            );
            const row = (
              await migration.query(
                "SELECT operation,source,revoked_sessions FROM auth.email_change_event WHERE account_id=$1",
                [entry.id],
              )
            ).rows[0];
            assert.deepEqual(row, {
              operation: "CHANGE_EMAIL",
              source: "SELF_SERVICE",
              revoked_sessions: 2,
            });
            assert.equal(
              (
                await migration.query(
                  "SELECT password_fingerprint FROM auth.email_change_challenge WHERE approval_digest=$1",
                  [hash(approval)],
                )
              ).rows[0].password_fingerprint.length,
              64,
            );
          },
        );
        await t.test(
          "MFA must be recent and replacing a factor invalidates issued authorization",
          async () => {
            const entry = await signup("email-mfa", true),
              newEmail = "email-mfa-new@example.test";
            assert.ok(entry.secret);
            await migration.query(
              'UPDATE auth.session SET "mfaVerifiedAt"=now()-interval \'5 minutes\' WHERE "userId"=$1',
              [entry.id],
            );
            const stale = await entry.client.request(
              "/api/me/email-change/request",
              { newEmail, password },
            );
            assert.equal(stale.statusCode, 403, stale.body);
            assert.equal(stale.json().error.code, "REAUTHENTICATION_REQUIRED");
            assert.equal(
              (
                await entry.client.request("/api/auth/two-factor/verify-totp", {
                  code: totp(entry.secret),
                })
              ).statusCode,
              200,
            );
            const token = await request(entry, newEmail);
            const codes = await entry.client.request(
              "/api/auth/two-factor/generate-backup-codes",
              { password },
            );
            assert.equal(codes.statusCode, 200, codes.body);
            assert.equal(
              (
                await entry.client.request("/api/me/email-change/approve", {
                  token,
                })
              ).statusCode,
              400,
            );
            assert.equal(await emailOf(entry.id), entry.email);
          },
        );
        await t.test(
          "password changes, later requests, expiry and lifecycle transitions invalidate old links",
          async () => {
            const entry = await signup("email-stale"),
              newEmail = "email-stale-new@example.test";
            const first = await request(entry, newEmail),
              second = await request(entry, newEmail);
            assert.equal(
              (
                await entry.client.request("/api/me/email-change/approve", {
                  token: first,
                })
              ).statusCode,
              400,
            );
            const verified = await approve(entry, newEmail, second);
            const changed = await entry.client.request(
              "/api/auth/change-password",
              {
                currentPassword: password,
                newPassword: "Replacement-email-password-123!",
              },
            );
            assert.equal(changed.statusCode, 200, changed.body);
            assert.equal(
              (
                await entry.client.request("/api/me/email-change/confirm", {
                  token: verified,
                })
              ).statusCode,
              400,
            );
            const expiring = await signup("email-expired"),
              token = await request(expiring, "email-expired-new@example.test");
            await migration.query(
              "UPDATE auth.email_change_challenge SET created_at=now()-interval '11 minutes',expires_at=now()-interval '1 minute' WHERE approval_digest=$1",
              [hash(token)],
            );
            assert.equal(
              (
                await expiring.client.request("/api/me/email-change/approve", {
                  token,
                })
              ).statusCode,
              400,
            );
            const suspended = await signup("email-suspended"),
              old = await request(
                suspended,
                "email-suspended-new@example.test",
              );
            await migration.query(
              "UPDATE auth.account_lifecycle SET suspended_at=clock_timestamp() WHERE account_id=$1",
              [suspended.id],
            );
            await migration.query(
              "UPDATE auth.account_lifecycle SET suspended_at=NULL WHERE account_id=$1",
              [suspended.id],
            );
            assert.equal(
              (
                await suspended.client.request("/api/me/email-change/approve", {
                  token: old,
                })
              ).statusCode,
              400,
            );
          },
        );
        await t.test(
          "delivery failure revokes challenge and target mailbox occupancy yields no partial update",
          async () => {
            const entry = await signup("email-conflict"),
              occupied = await signup("email-occupied");
            const before = messages.length;
            assert.equal(
              (
                await entry.client.request("/api/me/email-change/request", {
                  newEmail: occupied.email,
                  password,
                })
              ).statusCode,
              202,
            );
            assert.equal(messages.length, before);
            failDelivery = true;
            const failed = await entry.client.request(
              "/api/me/email-change/request",
              { newEmail: "delivery-failed@example.test", password },
            );
            failDelivery = false;
            assert.equal(failed.statusCode, 503, failed.body);
            assert.equal(
              (
                await migration.query(
                  "SELECT count(*)::int n FROM auth.email_change_challenge WHERE account_id=$1 AND revoked_at IS NULL AND consumed_at IS NULL",
                  [entry.id],
                )
              ).rows[0].n,
              0,
            );
            const newEmail = "target-race@example.test",
              old = await request(entry, newEmail),
              token = await approve(entry, newEmail, old);
            await signup("target-race");
            const conflict = await entry.client.request(
              "/api/me/email-change/confirm",
              { token },
            );
            assert.equal(conflict.statusCode, 409, conflict.body);
            assert.equal(await emailOf(entry.id), entry.email);
            assert.equal(
              (
                await migration.query(
                  "SELECT consumed_at FROM auth.email_change_challenge WHERE verification_digest=$1",
                  [hash(token)],
                )
              ).rows[0].consumed_at,
              null,
            );
            assert.equal(
              (await entry.client.request("/api/me")).statusCode,
              200,
            );
          },
        );
        await t.test(
          "audit failure rolls back email, consumed proof, session revocation and reset removal",
          async () => {
            const entry = await signup("email-audit"),
              newEmail = "email-audit-new@example.test",
              approval = await request(entry, newEmail),
              token = await approve(entry, newEmail, approval);
            await migration.query(
              "CREATE FUNCTION auth.reject_email_change_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic audit failure'; END $$; CREATE TRIGGER reject_email_change_audit BEFORE INSERT ON auth.email_change_event FOR EACH ROW EXECUTE FUNCTION auth.reject_email_change_audit()",
            );
            try {
              const failed = await entry.client.request(
                "/api/me/email-change/confirm",
                { token },
              );
              assert.equal(failed.statusCode, 500, failed.body);
              assert.equal(await emailOf(entry.id), entry.email);
              assert.equal(
                (await entry.client.request("/api/me")).statusCode,
                200,
              );
              assert.equal(
                (
                  await migration.query(
                    "SELECT consumed_at FROM auth.email_change_challenge WHERE verification_digest=$1",
                    [hash(token)],
                  )
                ).rows[0].consumed_at,
                null,
              );
            } finally {
              await migration.query(
                "DROP TRIGGER reject_email_change_audit ON auth.email_change_event; DROP FUNCTION auth.reject_email_change_audit()",
              );
            }
            assert.equal(
              (
                await entry.client.request("/api/me/email-change/confirm", {
                  token,
                })
              ).statusCode,
              200,
            );
          },
        );
        await t.test(
          "concurrent confirmation is one-use and cannot bypass a committing suspension",
          async () => {
            const entry = await signup("email-concurrent"),
              newEmail = "email-concurrent-new@example.test",
              approval = await request(entry, newEmail),
              token = await approve(entry, newEmail, approval);
            const responses = await Promise.all(
              [1, 2].map(() =>
                entry.client.request("/api/me/email-change/confirm", { token }),
              ),
            );
            assert.equal(
              responses.filter((r) => r.statusCode === 200).length,
              1,
            );
            assert.ok(
              responses.every((r) => [200, 400, 401].includes(r.statusCode)),
              responses.map((r) => r.body).join(),
            );
            assert.equal(
              (
                await migration.query(
                  "SELECT count(*)::int n FROM auth.email_change_event WHERE account_id=$1 AND operation='CHANGE_EMAIL'",
                  [entry.id],
                )
              ).rows[0].n,
              1,
            );
            const race = await signup("email-suspension-race"),
              old = await request(
                race,
                "email-suspension-race-new@example.test",
              ),
              final = await approve(
                race,
                "email-suspension-race-new@example.test",
                old,
              );
            const gate = await migration.connect();
            let confirming: ReturnType<typeof race.client.request> | undefined;
            try {
              await gate.query("BEGIN");
              await gate.query(
                "UPDATE auth.account_lifecycle SET suspended_at=clock_timestamp() WHERE account_id=$1",
                [race.id],
              );
              confirming = race.client.request("/api/me/email-change/confirm", {
                token: final,
              });
              let waiting = false;
              for (let i = 0; i < 100; i++) {
                const query = await administration.query(
                  "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT auth.complete_email_change%'",
                );
                if (query.rowCount) {
                  waiting = true;
                  break;
                }
                await setTimeout(20);
              }
              assert.ok(waiting);
              await gate.query("COMMIT");
              const rejected = await confirming;
              assert.equal(rejected.statusCode, 400, rejected.body);
              assert.equal(await emailOf(race.id), race.email);
            } finally {
              await gate.query("ROLLBACK");
              gate.release();
              if (confirming) await confirming;
            }
          },
        );
        await t.test(
          "assisted recovery is maintenance-only, verifies new mailbox and existing credentials without reactivation",
          async () => {
            const entry = await signup("email-assisted", true),
              newEmail = "email-assisted-new@example.test";
            for (const pool of [auth, domain, worker])
              await assert.rejects(
                pool.query(
                  "SELECT auth.issue_assisted_email_change($1,$2,$3,$4,$5,$6,$7)",
                  [
                    entry.id,
                    newEmail,
                    hash("token"),
                    "Operator",
                    "External-ref",
                    "Lost mailbox",
                    randomUUID(),
                  ],
                ),
                { code: "42501" },
              );
            const client = await migration.connect();
            try {
              await recoverEmail(
                client,
                entry.id,
                newEmail,
                {
                  performedBy: "Verified operator",
                  identityReference: "AUTH-2026-TEST",
                  reason: "Lost old mailbox",
                },
                mail,
                config.origin,
              );
            } finally {
              client.release();
            }
            assert.equal(await emailOf(entry.id), entry.email);
            const token = lastToken(newEmail, "confirm");
            assert.equal(
              (
                await entry.client.request("/api/me/email-change/confirm", {
                  token,
                })
              ).statusCode,
              403,
            );
            assert.equal(
              (
                await entry.client.request("/api/me/email-change/confirm", {
                  token,
                  password: "Incorrect-password-123!",
                })
              ).statusCode,
              403,
            );
            await migration.query(
              `UPDATE auth.session SET "mfaVerifiedAt"=now()-interval '5 minutes' WHERE "userId"=$1`,
              [entry.id],
            );
            const staleMfa = await entry.client.request(
              "/api/me/email-change/confirm",
              { token, password },
            );
            assert.equal(staleMfa.statusCode, 403, staleMfa.body);
            assert.equal(
              staleMfa.json().error.code,
              "REAUTHENTICATION_REQUIRED",
            );
            assert.ok(entry.secret);
            const refreshed = await entry.client.request(
              "/api/auth/two-factor/verify-totp",
              { code: totp(entry.secret) },
            );
            assert.equal(refreshed.statusCode, 200, refreshed.body);
            const confirmed = await entry.client.request(
              "/api/me/email-change/confirm",
              { token, password },
            );
            assert.equal(confirmed.statusCode, 200, confirmed.body);
            assert.equal(await emailOf(entry.id), newEmail);
            assert.equal(
              (
                await migration.query(
                  "SELECT count(*)::int n FROM auth.email_change_event WHERE account_id=$1 AND source='ASSISTED'",
                  [entry.id],
                )
              ).rows[0].n,
              2,
            );
            const suspended = await signup("email-assisted-inactive");
            await migration.query(
              "UPDATE auth.account_lifecycle SET suspended_at=clock_timestamp() WHERE account_id=$1",
              [suspended.id],
            );
            const maintenance = await migration.connect();
            try {
              await assert.rejects(
                recoverEmail(
                  maintenance,
                  suspended.id,
                  "email-assisted-inactive-new@example.test",
                  {
                    performedBy: "Operator",
                    identityReference: "Authority",
                    reason: "Lost mailbox",
                  },
                  mail,
                  config.origin,
                ),
              );
            } finally {
              maintenance.release();
            }
          },
        );
        contract.assertValid();
      } finally {
        await app.close();
      }
    },
  );
});
