import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { withDatabase } from "../helpers/postgres.ts";

test("exceptional blocked data access requires maintenance authorization and successful atomic audit", {
  timeout: 60000,
}, async () => {
  await withDatabase(async ({ migration, domain, auth, worker }) => {
    const archive = randomUUID(),
      correlation = randomUUID();
    const payload = { evidence: "Restricted synthetic evidence" };
    const event = (
      await migration.query(
        "INSERT INTO domain.retention_event(operation,category,target_key,subject_id,action) VALUES('RIGHTS_ACTION_APPLIED','IDENTITY','identity:subject','subject','BLOCK') RETURNING id",
      )
    ).rows[0].id;
    await migration.query(
      "INSERT INTO domain.retention_archive(id,event_id,category,target_key,subject_id,payload,destroy_after) VALUES($1,$2,'IDENTITY','identity:subject','subject',$3,now()+interval '1 day')",
      [archive, event, payload],
    );
    const sql =
      "SELECT domain.read_blocked_privacy_record($1,$2,$3,$4) AS payload";
    const args = [
      archive,
      "External authorization reference",
      "Verified legal purpose",
      correlation,
    ];
    const audits = () =>
      migration.query(
        "SELECT * FROM domain.retention_event WHERE operation='BLOCKED_RECORD_ACCESSED'",
      );
    for (const pool of [domain, auth, worker])
      await assert.rejects(pool.query(sql, args), { code: "42501" });
    for (const invalid of [
      [archive, " ", args[2], correlation],
      [archive, args[1], " ", correlation],
      [archive, args[1], args[2], null],
      [archive, "x".repeat(501), args[2], correlation],
    ])
      await assert.rejects(migration.query(sql, invalid), { code: "23514" });
    await assert.rejects(
      migration.query(sql, [randomUUID(), ...args.slice(1)]),
      { code: "P0002" },
    );
    assert.equal((await audits()).rowCount, 0);
    assert.deepEqual(
      (await migration.query(sql, args)).rows[0].payload,
      payload,
    );
    const recorded = await audits();
    assert.equal(recorded.rowCount, 1);
    assert.equal(recorded.rows[0].authorization_reference, args[1]);
    assert.equal(recorded.rows[0].reason, args[2]);
    assert.equal(recorded.rows[0].correlation_id, correlation);
    assert.deepEqual(recorded.rows[0].details, {
      archiveId: archive,
      maintenanceLogin: "quenda_migrator",
    });
    await migration.query(
      "CREATE FUNCTION domain.reject_blocked_access_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.operation='BLOCKED_RECORD_ACCESSED' THEN RAISE EXCEPTION 'synthetic blocked access audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_blocked_access_test BEFORE INSERT ON domain.retention_event FOR EACH ROW EXECUTE FUNCTION domain.reject_blocked_access_test()",
    );
    try {
      await assert.rejects(
        migration.query(sql, [archive, args[1], args[2], randomUUID()]),
        /synthetic blocked access audit failure/,
      );
      assert.equal((await audits()).rowCount, 1);
      assert.deepEqual(
        (
          await migration.query(
            "SELECT payload FROM domain.retention_archive WHERE id=$1",
            [archive],
          )
        ).rows[0].payload,
        payload,
      );
    } finally {
      await migration.query(
        "DROP TRIGGER reject_blocked_access_test ON domain.retention_event; DROP FUNCTION domain.reject_blocked_access_test()",
      );
    }
  });
});
