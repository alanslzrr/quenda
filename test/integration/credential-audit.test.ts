import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { transaction } from "../../src/database/transaction.ts";
import { withDatabase } from "../helpers/postgres.ts";

test("credential audit records changes atomically without copying secrets", {
  timeout: 60000,
}, async () => {
  await withDatabase(async ({ auth, domain, worker, migration }) => {
    const user = randomUUID();
    await auth.query(
      'INSERT INTO auth."user"(id,name,email,"emailVerified") VALUES($1,\'Fixture\',$2,true)',
      [user, `${user}@example.test`],
    );
    await auth.query(
      'INSERT INTO auth.account(id,"accountId","providerId","userId",password,"updatedAt") VALUES(\'credential\',$1,\'credential\',$1,\'hash-first-secret\',now())',
      [user],
    );
    const operations = async () =>
      (
        await migration.query(
          "SELECT operation FROM auth.credential_event WHERE subject_id=$1 ORDER BY occurred_at,id",
          [user],
        )
      ).rows.map((r) => r.operation);
    await auth.query(
      "UPDATE auth.account SET password='hash-second-secret' WHERE id='credential'",
    );
    await auth.query(
      "UPDATE auth.account SET password=password WHERE id='credential'",
    );
    await auth.query(
      "INSERT INTO auth.\"twoFactor\"(id,secret,\"backupCodes\",\"userId\") VALUES('factor','totp-secret','backup-secret',$1)",
      [user],
    );
    await auth.query(
      'UPDATE auth."user" SET "twoFactorEnabled"=true WHERE id=$1',
      [user],
    );
    await auth.query(
      "UPDATE auth.\"twoFactor\" SET \"backupCodes\"='remaining-secret' WHERE id='factor'",
    );
    await auth.query(
      'UPDATE auth."twoFactor" SET "failedVerificationCount"=1 WHERE id=\'factor\'',
    );
    const expected = [
      "PASSWORD_CREATED",
      "PASSWORD_CHANGED",
      "MFA_MATERIAL_CREATED",
      "MFA_ENABLED",
      "MFA_MATERIAL_CHANGED",
    ];
    assert.deepEqual(await operations(), expected);
    await assert.rejects(
      transaction(auth, async (c) => {
        await c.query(
          "UPDATE auth.account SET password='rollback-secret' WHERE id='credential'",
        );
        throw new Error("rollback");
      }),
      /rollback/,
    );
    assert.deepEqual(await operations(), expected);
    await migration.query(
      "CREATE FUNCTION auth.fail_credential_audit_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Fixture' USING ERRCODE='XX000'; END $$; CREATE TRIGGER fail_credential_audit_fixture BEFORE INSERT ON auth.credential_event FOR EACH ROW EXECUTE FUNCTION auth.fail_credential_audit_fixture()",
    );
    try {
      await assert.rejects(
        auth.query(
          "UPDATE auth.account SET password='failed-secret' WHERE id='credential'",
        ),
        { code: "XX000" },
      );
      assert.equal(
        (
          await auth.query(
            "SELECT password FROM auth.account WHERE id='credential'",
          )
        ).rows[0].password,
        "hash-second-secret",
      );
    } finally {
      await migration.query(
        "DROP TRIGGER fail_credential_audit_fixture ON auth.credential_event; DROP FUNCTION auth.fail_credential_audit_fixture()",
      );
    }
    await auth.query(
      'UPDATE auth."user" SET "twoFactorEnabled"=false WHERE id=$1',
      [user],
    );
    await auth.query("DELETE FROM auth.\"twoFactor\" WHERE id='factor'");
    await auth.query(
      "UPDATE auth.account SET password=NULL WHERE id='credential'",
    );
    assert.deepEqual(await operations(), [
      ...expected,
      "MFA_DISABLED",
      "MFA_MATERIAL_REMOVED",
      "PASSWORD_REMOVED",
    ]);
    for (const pool of [auth, domain, worker])
      for (const sql of [
        "SELECT * FROM auth.credential_event",
        "DELETE FROM auth.credential_event",
        "UPDATE auth.credential_event SET subject_id='forged'",
        "INSERT INTO auth.credential_event(subject_id,operation) VALUES('forged','PASSWORD_CREATED')",
      ])
        await assert.rejects(pool.query(sql), { code: "42501" });
    const rows = (await migration.query("SELECT * FROM auth.credential_event"))
      .rows;
    for (const row of rows)
      assert.deepEqual(Object.keys(row).sort(), [
        "id",
        "occurred_at",
        "operation",
        "subject_id",
      ]);
    assert.ok(!JSON.stringify(rows).includes("secret"));
    // Logical deactivation retains the identity and audit; runtime deletion is blocked.
    await assert.rejects(
      auth.query('DELETE FROM auth."user" WHERE id=$1', [user]),
      { code: "23503" },
    );
    assert.equal((await operations()).length, 8);
  });
});
