import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { auditedAuthenticationHandler } from "../../src/modules/identity/request-audit.ts";
import { withDatabase } from "../helpers/postgres.ts";

test("authentication attempts record bounded facts and fail closed on audit errors", {
  timeout: 60000,
}, async () => {
  await withDatabase(async ({ auth, domain, worker, migration }) => {
    const events = async (id: string) =>
      (
        await migration.query(
          "SELECT phase,operation,actor_id,http_status FROM auth.request_event WHERE request_id=$1 ORDER BY occurred_at",
          [id],
        )
      ).rows;
    let calls = 0,
      sessionReads = 0;
    const wrap = (status: number) =>
      auditedAuthenticationHandler(
        auth,
        async () => {
          calls++;
          return new Response(
            '{"twoFactorRedirect":true,"token":"response-secret"}',
            { status },
          );
        },
        async () => {
          sessionReads++;
          return "verified-account";
        },
      );
    const req = (path: string) =>
      new Request(`https://quenda.test/api/auth${path}?token=query-secret`, {
        method: "POST",
        headers: {
          cookie: "cookie-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          userId: "forged",
          email: "private@example.test",
          password: "password-secret",
        }),
      });
    for (const status of [200, 401, 403, 429, 500]) {
      const id = randomUUID();
      assert.equal(
        (await wrap(status)(req("/sign-in/email"), id)).status,
        status,
      );
      assert.deepEqual(await events(id), [
        {
          phase: "RECEIVED",
          operation: "SIGN_IN",
          actor_id: null,
          http_status: null,
        },
        {
          phase: "RETURNED",
          operation: "SIGN_IN",
          actor_id: null,
          http_status: status,
        },
      ]);
    }
    assert.equal(sessionReads, 0);
    const id = randomUUID();
    await wrap(200)(req("/sign-out"), id);
    assert.equal(sessionReads, 1);
    assert.ok(
      (await events(id)).every((row) => row.actor_id === "verified-account"),
    );
    const thrown = randomUUID();
    const failing = auditedAuthenticationHandler(
      auth,
      async () => {
        throw new Error("provider-secret");
      },
      async () => null,
    );
    await assert.rejects(
      failing(req("/sign-in/email"), thrown),
      /provider-secret/,
    );
    assert.deepEqual(
      (await events(thrown)).map((r) => r.phase),
      ["RECEIVED", "THREW"],
    );
    for (const pool of [auth, domain, worker])
      for (const sql of [
        "SELECT * FROM auth.request_event",
        "DELETE FROM auth.request_event",
        "UPDATE auth.request_event SET actor_id='forged'",
      ])
        await assert.rejects(pool.query(sql), { code: "42501" });
    const serialized = JSON.stringify(
      (await migration.query("SELECT * FROM auth.request_event")).rows,
    );
    for (const secret of [
      "secret",
      "private@example.test",
      "forged",
      "twoFactorRedirect",
    ])
      assert.ok(!serialized.includes(secret));
    await migration.query(
      "CREATE FUNCTION auth.fail_request_audit_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Fixture' USING ERRCODE='XX000'; END $$; CREATE TRIGGER fail_request_audit_fixture BEFORE INSERT ON auth.request_event FOR EACH ROW EXECUTE FUNCTION auth.fail_request_audit_fixture()",
    );
    const before = calls;
    try {
      await assert.rejects(wrap(200)(req("/sign-in/email")), {
        code: "UNAVAILABLE",
      });
      assert.equal(calls, before);
      await migration.query(
        "DROP TRIGGER fail_request_audit_fixture ON auth.request_event; CREATE TRIGGER fail_request_audit_fixture BEFORE INSERT ON auth.request_event FOR EACH ROW WHEN (NEW.phase='RETURNED') EXECUTE FUNCTION auth.fail_request_audit_fixture()",
      );
      const incomplete = randomUUID();
      await assert.rejects(wrap(200)(req("/sign-in/email"), incomplete), {
        code: "UNAVAILABLE",
      });
      assert.equal(calls, before + 1);
      assert.deepEqual(
        (await events(incomplete)).map((r) => r.phase),
        ["RECEIVED"],
      );
    } finally {
      await migration.query(
        "DROP TRIGGER fail_request_audit_fixture ON auth.request_event; DROP FUNCTION auth.fail_request_audit_fixture()",
      );
    }
  });
});
