import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { transaction } from "../../src/database/transaction.ts";
import { withDatabase } from "../helpers/postgres.ts";

test("session audit is atomic, restricted and excludes session credentials", {
  timeout: 60000,
}, async () => {
  await withDatabase(async ({ auth, domain, worker, migration }) => {
    const account = randomUUID(),
      session = randomUUID(),
      secret = randomUUID();
    await auth.query(
      'INSERT INTO auth."user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,\'Synthetic\',$2,true,now(),now())',
      [account, `${account}@example.test`],
    );
    const insert =
      'INSERT INTO auth.session(id,token,"userId","expiresAt","updatedAt","ipAddress","userAgent") VALUES($1,$2,$3,now()+interval \'1 day\',now(),\'192.0.2.1\',\'secret-agent\')';
    const events = async () =>
      (
        await migration.query(
          "SELECT * FROM auth.session_event WHERE subject_id=$1 ORDER BY occurred_at,id",
          [account],
        )
      ).rows;
    await auth.query(insert, [session, secret, account]);
    await auth.query(
      'UPDATE auth.session SET "mfaVerifiedAt"=now() WHERE id=$1',
      [session],
    );
    await auth.query(
      'UPDATE auth.session SET "mfaVerifiedAt"="mfaVerifiedAt","updatedAt"=now() WHERE id=$1',
      [session],
    );
    await assert.rejects(
      transaction(auth, async (c) => {
        await c.query("DELETE FROM auth.session WHERE id=$1", [session]);
        throw new Error("rollback");
      }),
      /rollback/,
    );
    assert.equal((await events()).length, 2);
    assert.equal(
      (await auth.query("SELECT 1 FROM auth.session WHERE id=$1", [session]))
        .rowCount,
      1,
    );
    await auth.query("DELETE FROM auth.session WHERE id=$1", [session]);
    const recorded = await events();
    assert.deepEqual(
      recorded.map((row) => row.operation),
      ["SESSION_CREATED", "SESSION_MFA_PROOF_CHANGED", "SESSION_REMOVED"],
    );
    for (const row of recorded)
      assert.deepEqual(Object.keys(row).sort(), [
        "id",
        "occurred_at",
        "operation",
        "subject_id",
      ]);
    for (const value of [
      session,
      secret,
      "192.0.2.1",
      "secret-agent",
      `${account}@example.test`,
    ])
      assert.ok(!JSON.stringify(recorded).includes(value));
    for (const pool of [auth, domain, worker])
      for (const sql of [
        "SELECT * FROM auth.session_event",
        "DELETE FROM auth.session_event",
        "UPDATE auth.session_event SET subject_id='forged'",
        "INSERT INTO auth.session_event(subject_id,operation) VALUES('forged','SESSION_CREATED')",
      ])
        await assert.rejects(pool.query(sql), { code: "42501" });
    await migration.query(
      "CREATE FUNCTION auth.fail_session_audit_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Fixture failure' USING ERRCODE='XX000'; END $$; CREATE TRIGGER fail_session_audit_fixture BEFORE INSERT ON auth.session_event FOR EACH ROW EXECUTE FUNCTION auth.fail_session_audit_fixture()",
    );
    try {
      await assert.rejects(auth.query(insert, [session, secret, account]), {
        code: "XX000",
      });
      assert.equal(
        (await auth.query("SELECT 1 FROM auth.session WHERE id=$1", [session]))
          .rowCount,
        0,
      );
      assert.equal((await events()).length, 3);
    } finally {
      await migration.query(
        "DROP TRIGGER fail_session_audit_fixture ON auth.session_event; DROP FUNCTION auth.fail_session_audit_fixture()",
      );
    }
    // Logical deactivation retains the identity and audit; runtime deletion is blocked.
    await assert.rejects(
      auth.query('DELETE FROM auth."user" WHERE id=$1', [account]),
      { code: "23503" },
    );
    assert.equal((await events()).length, 3);
  });
});
