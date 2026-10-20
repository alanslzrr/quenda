import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import type { Pool } from "pg";
import { command } from "../../src/database/command.ts";
import { withDatabase } from "../helpers/postgres.ts";

const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
async function identity(pool: Pool, id: string, deactivated = true) {
  await pool.query(
    `INSERT INTO auth."user"(id,name,email,"emailVerified",image,"updatedAt") VALUES($1,'Nombre personal',$2,true,'https://example.test/personal.png',now())`,
    [id, `${id}@example.test`],
  );
  await pool.query(
    `INSERT INTO auth.account(id,"accountId","providerId","userId",password,"updatedAt") VALUES($1,$1,'credential',$1,'credential-sensitive-secret',now())`,
    [id],
  );
  await pool.query(
    `INSERT INTO auth.session(id,"expiresAt",token,"userId","updatedAt","ipAddress","userAgent") VALUES($1,now()-interval '90 days',$2,$3,now(),'192.0.2.1','Synthetic user agent')`,
    [`session-${id}`, `secret-${id}`, id],
  );
  await pool.query(
    "INSERT INTO domain.account_preferences(account_id,locale) VALUES($1,'gl')",
    [id],
  );
  if (deactivated)
    await pool.query(
      "UPDATE auth.account_lifecycle SET deactivated_at=now()-interval '60 days' WHERE account_id=$1",
      [id],
    );
}
const action = async (
  pool: Pool,
  category: string,
  key: string,
  tenant: string | null = null,
) =>
  command(
    pool,
    undefined,
    async (c) =>
      (
        await c.query<{
          result: {
            status: string;
            reason?: string;
            subjectId: string | null;
            payload: unknown;
          };
        }>("SELECT domain.retention_identity_action($1,$2,$3,$4) AS result", [
          tenant,
          category,
          key,
          cutoff,
        ])
      ).rows[0]?.result,
  );

test("global retention retires inactive identity without reviving credentials and handles authentication evidence independently", {
  timeout: 60000,
}, async (t) => {
  await withDatabase(
    async ({ migration, domain, auth, worker, administration }) => {
      await identity(migration, "retention-actor", false);
      await t.test(
        "inactive identity becomes non-reactivable tombstone; retained references are not anonymous",
        async () => {
          const subject = "identity-erased";
          await identity(migration, subject);
          const tenant = randomUUID();
          await migration.query(
            "INSERT INTO domain.municipality(id,name,timezone) VALUES($1,'Independent municipality','Europe/Madrid')",
            [tenant],
          );
          await migration.query(
            "INSERT INTO domain.municipal_profile(tenant_id,account_id) VALUES($1,$2)",
            [tenant, subject],
          );
          const candidates = await migration.query(
            "SELECT * FROM domain.retention_identity_candidates(NULL,'IDENTITY',$1,100)",
            [cutoff],
          );
          assert.ok(
            candidates.rows.some((r) => r.target_key === `identity:${subject}`),
          );
          for (const pool of [domain, auth, worker])
            await assert.rejects(
              pool.query(
                "SELECT domain.retention_identity_action(NULL,'IDENTITY',$1,$2)",
                [`identity:${subject}`, cutoff],
              ),
              { code: "42501" },
            );
          const protectedIdentity = await action(
            migration,
            "IDENTITY",
            `identity:${subject}`,
          );
          assert.equal(
            protectedIdentity?.reason,
            "MUNICIPAL_EVIDENCE_REQUIRES_IDENTITY",
          );
          assert.equal(
            (
              await migration.query(
                'SELECT email FROM auth."user" WHERE id=$1',
                [subject],
              )
            ).rows[0].email,
            `${subject}@example.test`,
          );
          // The separate municipal controller first completes its own authorized
          // deletion; global policy cannot perform that deletion on its behalf.
          await migration.query(
            "DELETE FROM domain.municipal_profile WHERE tenant_id=$1 AND account_id=$2",
            [tenant, subject],
          );
          const result = await action(
            migration,
            "IDENTITY",
            `identity:${subject}`,
          );
          assert.equal(result?.status, "APPLIED");
          const payload = JSON.stringify(result?.payload);
          assert.ok(payload.includes(`${subject}@example.test`));
          assert.ok(payload.includes("PSEUDONYMOUS_NOT_ANONYMOUS"));
          assert.ok(!payload.includes("credential-sensitive-secret"));
          assert.ok(!payload.includes(`secret-${subject}`));
          const erased = (
            await migration.query(
              'SELECT u.name,u.email,u."emailVerified",u.image,l.erased_at,l.deactivated_at FROM auth."user" u JOIN auth.account_lifecycle l ON l.account_id=u.id WHERE u.id=$1',
              [subject],
            )
          ).rows[0];
          assert.equal(erased.name, "Cuenta suprimida");
          assert.match(erased.email, /^[a-f0-9]{64}@erased\.invalid$/);
          assert.equal(erased.emailVerified, false);
          assert.equal(erased.image, null);
          assert.ok(erased.erased_at);
          assert.ok(erased.deactivated_at);
          for (const table of ["account", "session"])
            assert.equal(
              (
                await migration.query(
                  `SELECT 1 FROM auth.${table} WHERE "userId"=$1`,
                  [subject],
                )
              ).rowCount,
              0,
            );
          assert.equal(
            (
              await migration.query(
                "SELECT 1 FROM domain.account_preferences WHERE account_id=$1",
                [subject],
              )
            ).rowCount,
            0,
          );
          assert.equal(
            (
              await migration.query(
                "SELECT 1 FROM domain.municipal_profile WHERE account_id=$1 AND tenant_id=$2",
                [subject, tenant],
              )
            ).rowCount,
            0,
          );
          assert.equal(
            (await action(migration, "IDENTITY", `identity:${subject}`))
              ?.status,
            "ABSENT",
          );
          await assert.rejects(
            migration.query(
              "UPDATE auth.account_lifecycle SET deactivated_at=NULL WHERE account_id=$1",
              [subject],
            ),
            { code: "42501" },
          );
          await assert.rejects(
            migration.query(
              "UPDATE auth.account_lifecycle SET erased_at=NULL WHERE account_id=$1",
              [subject],
            ),
            { code: "42501" },
          );
          await assert.rejects(
            migration.query(
              'UPDATE auth."user" SET name=\'Restored identity\',"emailVerified"=true WHERE id=$1',
              [subject],
            ),
            { code: "42501" },
          );
          await assert.rejects(
            auth.query(
              `INSERT INTO auth.account(id,"accountId","providerId","userId",password,"updatedAt") VALUES($1,$1,'credential',$1,'new-secret',now())`,
              [subject],
            ),
            { code: "42501" },
          );
          const reactivable = await command(
            auth,
            undefined,
            async (c) =>
              (
                await c.query(
                  "SELECT auth.lock_reactivation_account($1) AS active",
                  [subject],
                )
              ).rows[0].active,
          );
          assert.equal(reactivable, false);
          // Re-registration creates a distinct identity; it does not restore historical references.
          await migration.query(
            `INSERT INTO auth."user"(id,name,email,"emailVerified","updatedAt") VALUES('new-identity','New registration',$1,true,now())`,
            [`${subject}@example.test`],
          );
        },
      );
      await t.test(
        "active, security-suspended, held and wrong-scope identities are not erased",
        async () => {
          await identity(migration, "identity-active", false);
          assert.equal(
            (await action(migration, "IDENTITY", "identity:identity-active"))
              ?.reason,
            "IDENTITY_NOT_DUE",
          );
          await identity(migration, "identity-suspended");
          await migration.query(
            "UPDATE auth.account_lifecycle SET suspended_at=now() WHERE account_id='identity-suspended'",
          );
          assert.equal(
            (await action(migration, "IDENTITY", "identity:identity-suspended"))
              ?.reason,
            "SECURITY_REVIEW_REQUIRED",
          );
          await identity(migration, "identity-held");
          await migration.query(
            "INSERT INTO domain.retention_hold(id,category,subject_id,authority_reference,reason,created_by) VALUES($1,'IDENTITY','identity-held','Approved legal hold','Necessary evidence','retention-actor')",
            [randomUUID()],
          );
          assert.equal(
            (await action(migration, "IDENTITY", "identity:identity-held"))
              ?.reason,
            "LEGAL_HOLD",
          );
          assert.equal(
            (
              await action(
                migration,
                "IDENTITY",
                "identity:identity-held",
                randomUUID(),
              )
            )?.reason,
            "INVALID_SCOPE",
          );
          assert.equal(
            (
              await migration.query(
                "SELECT 1 FROM auth.account WHERE \"userId\"='identity-held'",
              )
            ).rowCount,
            1,
          );
        },
      );
      await t.test(
        "authentication holds prevent deleting dependent identity credentials",
        async () => {
          await identity(migration, "identity-auth-held");
          await migration.query(
            "INSERT INTO domain.retention_hold(id,category,subject_id,authority_reference,reason,created_by) VALUES($1,'AUTHENTICATION','identity-auth-held','Approved retention hold','Required authentication evidence','retention-actor')",
            [randomUUID()],
          );
          assert.equal(
            (await action(migration, "IDENTITY", "identity:identity-auth-held"))
              ?.reason,
            "AUTHENTICATION_HOLD",
          );
          assert.equal(
            (
              await migration.query(
                'SELECT 1 FROM auth.account WHERE "userId"=$1',
                ["identity-auth-held"],
              )
            ).rowCount,
            1,
          );
        },
      );
      await t.test(
        "municipal blocked evidence and cross-category legal holds retain identity resolution",
        async () => {
          const subject = "identity-archived";
          await identity(migration, subject);
          const tenant = randomUUID();
          await migration.query(
            "INSERT INTO domain.municipality(id,name,timezone) VALUES($1,'Archive controller','Europe/Madrid')",
            [tenant],
          );
          const event = (
            await migration.query(
              "INSERT INTO domain.retention_event(operation,tenant_id,category,target_key,subject_id,action) VALUES('RIGHTS_ACTION_APPLIED',$1,'MUNICIPAL_PROFILE',$2,$2,'BLOCK') RETURNING id",
              [tenant, subject],
            )
          ).rows[0].id;
          const archive = randomUUID();
          await migration.query(
            "INSERT INTO domain.retention_archive(id,event_id,tenant_id,category,target_key,subject_id,payload,destroy_after) VALUES($1,$2,$3,'MUNICIPAL_PROFILE',$4,$4,'{}',now()+interval '30 days')",
            [archive, event, tenant, subject],
          );
          assert.equal(
            (await action(migration, "IDENTITY", `identity:${subject}`))
              ?.reason,
            "ARCHIVED_MUNICIPAL_EVIDENCE_REQUIRES_IDENTITY",
          );
          assert.equal(
            (
              await migration.query(
                'SELECT email FROM auth."user" WHERE id=$1',
                [subject],
              )
            ).rows[0].email,
            `${subject}@example.test`,
          );
          await migration.query(
            "DELETE FROM domain.retention_archive WHERE id=$1",
            [archive],
          );
          await migration.query(
            "INSERT INTO domain.retention_hold(id,category,target_key,authority_reference,reason,created_by) VALUES($1,'AUTHORITY',$2,'Legal hold','Identity needed','retention-actor')",
            [randomUUID(), subject],
          );
          assert.equal(
            (await action(migration, "IDENTITY", `identity:${subject}`))
              ?.reason,
            "IDENTITY_EVIDENCE_HELD",
          );
        },
      );
      await t.test(
        "audit failure rolls back erasure, secret withdrawal and tombstone",
        async () => {
          const subject = "identity-rollback";
          await identity(migration, subject);
          await migration.query(
            "CREATE FUNCTION auth.reject_retention_credential_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic audit failure'; END $$; CREATE TRIGGER reject_retention_credential_audit BEFORE INSERT ON auth.credential_event FOR EACH ROW EXECUTE FUNCTION auth.reject_retention_credential_audit()",
          );
          try {
            await assert.rejects(
              action(migration, "IDENTITY", `identity:${subject}`),
            );
          } finally {
            await migration.query(
              "DROP TRIGGER reject_retention_credential_audit ON auth.credential_event; DROP FUNCTION auth.reject_retention_credential_audit()",
            );
          }
          assert.equal(
            (
              await migration.query(
                'SELECT email FROM auth."user" WHERE id=$1',
                [subject],
              )
            ).rows[0].email,
            `${subject}@example.test`,
          );
          assert.equal(
            (
              await migration.query(
                "SELECT erased_at FROM auth.account_lifecycle WHERE account_id=$1",
                [subject],
              )
            ).rows[0].erased_at,
            null,
          );
          assert.equal(
            (
              await migration.query(
                'SELECT 1 FROM auth.account WHERE "userId"=$1',
                [subject],
              )
            ).rowCount,
            1,
          );
          assert.equal(
            (
              await migration.query(
                'SELECT 1 FROM auth.session WHERE "userId"=$1',
                [subject],
              )
            ).rowCount,
            1,
          );
        },
      );
      await t.test(
        "authentication retention removes only due closed evidence and expired sessions, with no secrets in blocked payload",
        async () => {
          const subject = "auth-evidence";
          await identity(migration, subject, false);
          const old = randomUUID(),
            recent = randomUUID(),
            request = randomUUID(),
            openRequest = randomUUID();
          await migration.query(
            "INSERT INTO auth.session_event(id,subject_id,operation,occurred_at) VALUES($1,$3,'SESSION_CREATED',now()-interval '90 days'),($2,$3,'SESSION_CREATED',now())",
            [old, recent, subject],
          );
          await migration.query(
            "INSERT INTO auth.request_event(request_id,phase,operation,actor_id,http_status,occurred_at) VALUES($1,'RECEIVED','SIGN_OUT',$2,NULL,now()-interval '90 days'),($1,'RETURNED','SIGN_OUT',$2,200,now()-interval '90 days'),($3,'RECEIVED','SIGN_OUT',$2,NULL,now()-interval '90 days')",
            [request, subject, openRequest],
          );
          assert.equal(
            (
              await action(
                migration,
                "AUTHENTICATION",
                `session-event:${recent}`,
              )
            )?.reason,
            "NOT_DUE",
          );
          const deleted = await action(
            migration,
            "AUTHENTICATION",
            `session-event:${old}`,
          );
          assert.equal(deleted?.status, "APPLIED");
          assert.equal(deleted?.subjectId, subject);
          const closed = await action(
            migration,
            "AUTHENTICATION",
            `request-event:${request}`,
          );
          assert.equal(closed?.status, "APPLIED");
          assert.ok(closed);
          assert.equal((closed.payload as unknown[]).length, 2);
          assert.equal(
            (
              await action(
                migration,
                "AUTHENTICATION",
                `request-event:${openRequest}`,
              )
            )?.reason,
            "INCOMPLETE_AUTHENTICATION_AUDIT",
          );
          assert.equal(
            (
              await migration.query(
                "SELECT 1 FROM auth.request_event WHERE request_id=$1",
                [openRequest],
              )
            ).rowCount,
            1,
          );
          const session = await action(
            migration,
            "AUTHENTICATION",
            `expired-session:session-${subject}`,
          );
          assert.equal(session?.status, "APPLIED");
          assert.ok(
            !JSON.stringify(session?.payload).includes(`secret-${subject}`),
          );
          assert.ok(JSON.stringify(session?.payload).includes("192.0.2.1"));
          assert.equal(
            (
              await migration.query(
                'SELECT 1 FROM auth.account WHERE "userId"=$1',
                [subject],
              )
            ).rowCount,
            1,
          );
        },
      );
      await t.test(
        "lifecycle, security and email evidence expire under AUTHENTICATION, without archiving reset tokens",
        async () => {
          const subject = "lifecycle-auth-evidence";
          await identity(migration, subject, false);
          const ids = {
            deactivation: randomUUID(),
            reactivation: randomUUID(),
            security: randomUUID(),
            email: randomUUID(),
            verification: randomUUID(),
          };
          await migration.query(
            "INSERT INTO auth.account_deactivation_event(id,subject_id,occurred_at,correlation_id,revoked_sessions) VALUES($1,$2,now()-interval '90 days',$3,1)",
            [ids.deactivation, subject, randomUUID()],
          );
          await migration.query(
            "INSERT INTO auth.account_reactivation_event(id,subject_id,previous_deactivated_at,occurred_at,correlation_id) VALUES($1,$2,now()-interval '100 days',now()-interval '90 days',$3)",
            [ids.reactivation, subject, randomUUID()],
          );
          await migration.query(
            "INSERT INTO auth.account_security_event(id,subject_id,actor_id,operation,reason,occurred_at,correlation_id) VALUES($1,$2,'retention-actor','SUSPEND_ACCOUNT','Closed investigation',now()-interval '90 days',$3)",
            [ids.security, subject, randomUUID()],
          );
          await migration.query(
            "INSERT INTO auth.email_change_event(id,account_id,operation,source,occurred_at,correlation_id) VALUES($1,$2,'CHANGE_EMAIL','SELF_SERVICE',now()-interval '90 days',$3)",
            [ids.email, subject, randomUUID()],
          );
          await migration.query(
            `INSERT INTO auth.verification(id,identifier,value,"expiresAt","createdAt","updatedAt") VALUES($1,'reset-password:never-archive-token',$2,now()-interval '90 days',now()-interval '91 days',now()-interval '91 days')`,
            [ids.verification, subject],
          );
          const keys = [
            `deactivation-event:${ids.deactivation}`,
            `reactivation-event:${ids.reactivation}`,
            `security-event:${ids.security}`,
            `email-event:${ids.email}`,
            `expired-verification:${ids.verification}`,
          ];
          const candidates = await migration.query(
            "SELECT target_key FROM domain.retention_identity_candidates(NULL,'AUTHENTICATION',$1,500)",
            [cutoff],
          );
          for (const key of keys) {
            assert.ok(
              candidates.rows.some((r) => r.target_key === key),
              `Missing candidate ${key}`,
            );
            const result = await action(migration, "AUTHENTICATION", key);
            assert.equal(result?.status, "APPLIED");
            assert.equal(result?.subjectId, subject);
            assert.ok(
              !JSON.stringify(result?.payload).includes("never-archive-token"),
            );
          }
        },
      );
      await t.test(
        "a reactivation committing ahead of retention prevents stale-snapshot erasure",
        async () => {
          const subject = "identity-recovery-race";
          await identity(migration, subject);
          const gate = await migration.connect();
          let pending: ReturnType<typeof action> | undefined;
          try {
            await gate.query("BEGIN");
            await gate.query(
              "UPDATE auth.account_lifecycle SET deactivated_at=NULL WHERE account_id=$1",
              [subject],
            );
            pending = action(migration, "IDENTITY", `identity:${subject}`);
            let waiting = false;
            for (let n = 0; n < 100; n++) {
              const q = await administration.query(
                "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT domain.retention_identity_action%'",
              );
              if (q.rowCount) {
                waiting = true;
                break;
              }
              await setTimeout(20);
            }
            assert.ok(waiting);
            await gate.query("COMMIT");
            assert.equal((await pending)?.reason, "IDENTITY_NOT_DUE");
          } finally {
            await gate.query("ROLLBACK");
            gate.release();
            if (pending) await pending;
          }
          assert.equal(
            (
              await migration.query(
                'SELECT email FROM auth."user" WHERE id=$1',
                [subject],
              )
            ).rows[0].email,
            `${subject}@example.test`,
          );
        },
      );
    },
  );
});
