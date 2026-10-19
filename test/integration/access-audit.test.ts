import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { buildApp } from "../../src/app.ts";
import { transaction } from "../../src/database/transaction.ts";
import { HttpError } from "../../src/http/errors.ts";
import { createRequestActor } from "../../src/modules/identity/index.ts";
import { withDatabase } from "../helpers/postgres.ts";

test("authenticated access denials are durable, minimal and append-only", {
  timeout: 60000,
}, async (t) => {
  await withDatabase(async ({ auth, domain, migration }) => {
    await auth.query(
      `INSERT INTO auth."user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ('audited','Audited','audit@example.test',true,now(),now())`,
    );
    const account = {
      accountId: "audited",
      email: "audit@example.test",
      sessionId: "private-session",
      mfaVerifiedAt: new Date(),
    };
    const config = {
      origin: "https://quenda.test",
      secret: "unused-in-authentication-test-double",
    };
    const unavailable = async (): Promise<never> => {
      throw new Error("unused");
    };
    const authentication = {
      handler: unavailable,
      schema: unavailable,
      authenticate: async () => account,
    };
    const app = await buildApp({
      database: { check: async () => {}, close: async () => {} },
      domain,
      logLevel: "silent",
      identity: { authentication, config },
    });
    const actor = createRequestActor(domain, authentication, config);
    app.post(
      "/audit-rollback/:tenantId",
      { schema: { operationId: "auditRollback" } },
      async (request, reply) => {
        const subject = await actor(request, reply);
        return transaction(
          domain,
          async (client) => {
            await client.query(
              "INSERT INTO domain.access_denial(request_id,actor_id,operation,outcome) VALUES ($1,$2,'rolledBack','FORBIDDEN')",
              [randomUUID(), subject.accountId],
            );
            throw new HttpError("FORBIDDEN");
          },
          { accountId: subject.accountId, tenantId: null },
        );
      },
    );
    const tenantId = randomUUID();
    const headers = {
      origin: config.origin,
      "x-request-id": "untrusted-id",
      "x-account-id": "impostor",
      cookie: "secret-cookie",
    };
    try {
      await t.test(
        "real permission rejection records only verified actor and bounded metadata",
        async () => {
          const response = await app.inject({
            method: "POST",
            url: `/api/municipalities/${tenantId}/facilities`,
            headers,
            payload: { name: "private-body" },
          });
          assert.equal(response.statusCode, 403);
          const rows = (
            await migration.query("SELECT * FROM domain.access_denial")
          ).rows;
          assert.equal(rows.length, 1);
          assert.equal(rows[0].actor_id, account.accountId);
          assert.equal(rows[0].requested_tenant_id, tenantId);
          assert.equal(rows[0].request_id, response.json().requestId);
          assert.equal(rows[0].operation, "createFacility");
          assert.equal(rows[0].outcome, "FORBIDDEN");
          assert.ok(rows[0].occurred_at instanceof Date);
          assert.deepEqual(Object.keys(rows[0]).sort(), [
            "actor_id",
            "occurred_at",
            "operation",
            "outcome",
            "request_id",
            "requested_tenant_id",
          ]);
          assert.doesNotMatch(
            JSON.stringify(rows),
            /private-body|secret-cookie|private-session|impostor|untrusted-id/,
          );
        },
      );
      await t.test(
        "rejection audit commits independently after the failed transaction rolls back",
        async () => {
          const response = await app.inject({
            method: "POST",
            url: `/audit-rollback/${tenantId}`,
            headers,
            payload: { secret: "never-persist" },
          });
          assert.equal(response.statusCode, 403);
          const rows = (
            await migration.query(
              "SELECT * FROM domain.access_denial WHERE operation IN ('rolledBack','auditRollback')",
            )
          ).rows;
          assert.equal(rows.length, 1);
          assert.equal(rows[0].operation, "auditRollback");
          assert.equal(rows[0].request_id, response.json().requestId);
        },
      );
      await t.test(
        "CSRF rejection is not attributed using unverified client headers",
        async () => {
          const before = await migration.query(
            "SELECT count(*) FROM domain.access_denial",
          );
          const response = await app.inject({
            method: "POST",
            url: `/api/municipalities/${tenantId}/facilities`,
            headers: { ...headers, origin: "https://evil.test" },
            payload: { name: "not-created" },
          });
          assert.equal(response.statusCode, 403);
          assert.deepEqual(
            (await migration.query("SELECT count(*) FROM domain.access_denial"))
              .rows,
            before.rows,
          );
        },
      );
      await t.test(
        "runtime cannot read, mutate or forge audit rows without matching transaction context",
        async () => {
          for (const sql of [
            "SELECT * FROM domain.access_denial",
            "UPDATE domain.access_denial SET outcome='NOT_FOUND'",
            "DELETE FROM domain.access_denial",
            "TRUNCATE domain.access_denial",
          ])
            await assert.rejects(domain.query(sql), { code: "42501" });
          await assert.rejects(
            domain.query(
              "INSERT INTO domain.access_denial(request_id,actor_id,operation,outcome) VALUES ($1,'audited','forged','FORBIDDEN')",
              [randomUUID()],
            ),
            { code: "42501" },
          );
          await assert.rejects(
            transaction(
              domain,
              (c) =>
                c.query(
                  "INSERT INTO domain.access_denial(request_id,actor_id,operation,outcome) VALUES ($1,'other','forged','FORBIDDEN')",
                  [randomUUID()],
                ),
              { accountId: "audited", tenantId },
            ),
            { code: "42501" },
          );
        },
      );
      await t.test(
        "failed audit storage yields unavailable without leaking database diagnostics",
        async () => {
          await migration.query(
            "REVOKE INSERT ON domain.access_denial FROM quenda_domain",
          );
          try {
            const response = await app.inject({
              method: "POST",
              url: `/api/municipalities/${tenantId}/facilities`,
              headers,
              payload: { name: "not-created" },
            });
            assert.equal(response.statusCode, 503);
            assert.equal(response.json().error.code, "UNAVAILABLE");
            assert.doesNotMatch(
              response.body,
              /access_denial|permission denied|42501/,
            );
          } finally {
            await migration.query(
              "GRANT INSERT ON domain.access_denial TO quenda_domain",
            );
          }
        },
      );
    } finally {
      await app.close();
    }
  });
});
