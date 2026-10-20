import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  exportPrivacyCheckpoint,
  type PrivacyCheckpoint,
  reconcilePrivacyCheckpoint,
} from "../../scripts/lib/privacy-checkpoint.ts";
import { command } from "../../src/database/command.ts";
import { withDatabase } from "../helpers/postgres.ts";

test("privacy replay preserves original ledger identities, destruction evidence and exact timestamps while rejecting collisions", {
  timeout: 60000,
}, async (t) => {
  await withDatabase(async ({ migration }) => {
    await migration.query(
      `INSERT INTO auth."user"(id,name,email,"emailVerified","updatedAt") VALUES('checkpoint-subject','Synthetic','checkpoint-subject@example.test',true,now())`,
    );
    const tenant = randomUUID();
    await migration.query(
      "INSERT INTO domain.municipality(id,name,timezone) VALUES($1,'Synthetic','Europe/Madrid')",
      [tenant],
    );
    await migration.query(
      "INSERT INTO domain.municipal_profile(tenant_id,account_id,created_at) VALUES($1,'checkpoint-subject',now()-interval '30 days')",
      [tenant],
    );
    const cutoff = new Date(Date.now() - 86400000).toISOString();
    await command(migration, undefined, async (client) => {
      const result = (
        await client.query(
          "SELECT domain.retention_apply($1,'MUNICIPAL_PROFILE','checkpoint-subject',$2) result",
          [tenant, cutoff],
        )
      ).rows[0].result;
      assert.equal(result.status, "APPLIED");
      await client.query(
        `INSERT INTO domain.retention_event(id,operation,tenant_id,category,target_key,subject_id,action,authorization_reference,occurred_at,details)
    OVERRIDING SYSTEM VALUE VALUES(41,'RIGHTS_ACTION_APPLIED',$1,'MUNICIPAL_PROFILE','checkpoint-subject','checkpoint-subject','BLOCK','External rights authority','2026-01-01T12:34:56.123456Z',$2)`,
        [tenant, JSON.stringify({ cutoff })],
      );
      await client.query(
        `INSERT INTO domain.retention_event(id,operation,tenant_id,category,target_key,subject_id,action,details)
    OVERRIDING SYSTEM VALUE VALUES(70,'ARCHIVE_DESTROYED',$1,'MUNICIPAL_PROFILE','checkpoint-subject','checkpoint-subject','ERASE',$2)`,
        [
          tenant,
          JSON.stringify({ blockedEvent: "41", archiveId: randomUUID() }),
        ],
      );
    });
    const client = await migration.connect();
    let checkpoint: PrivacyCheckpoint;
    try {
      checkpoint = await exportPrivacyCheckpoint(client);
    } finally {
      client.release();
    }
    assert.equal(checkpoint.ledgerHead, "70");
    assert.equal(
      checkpoint.actions[0]?.occurredAt,
      "2026-01-01T12:34:56.123456Z",
    );
    assert.equal(checkpoint.actions[0]?.archiveDestroyed, true);
    // Simulate the older, still-closed snapshot; the separate recovery test performs
    // a real pg_dump/pg_restore round-trip with the same replay contract.
    await migration.query(
      "DELETE FROM domain.retention_event; SELECT setval(pg_get_serial_sequence('domain.retention_event','id'),1,false); UPDATE domain.retention_control SET restore_review_required=true WHERE id",
    );
    await migration.query(
      "INSERT INTO domain.municipal_profile(tenant_id,account_id,created_at) VALUES($1,'checkpoint-subject',now()-interval '30 days')",
      [tenant],
    );
    await t.test(
      "destroyed archives remain destroyed across replay, re-export and retry",
      async () => {
        const connection = await migration.connect();
        try {
          const first = await reconcilePrivacyCheckpoint(
            connection,
            checkpoint,
            "a".repeat(64),
            "Controlled recovery",
          );
          assert.equal(first.replayed, 1);
          assert.equal(first.reopeningAuthorized, false);
          const next = await exportPrivacyCheckpoint(connection);
          assert.equal(next.actions.length, 1);
          assert.deepEqual(next.actions[0], checkpoint.actions[0]);
          assert.ok(BigInt(next.ledgerHead) > 70n);
          const repeated = await reconcilePrivacyCheckpoint(
            connection,
            checkpoint,
            "a".repeat(64),
            "Controlled retry",
          );
          assert.equal(repeated.replayed, 0);
          assert.equal(
            (
              await connection.query(
                "SELECT count(*)::int n FROM domain.retention_event WHERE operation='ARCHIVE_DESTROYED'",
              )
            ).rows[0].n,
            1,
          );
          assert.equal(
            (
              await connection.query(
                "SELECT count(*)::int n FROM domain.retention_archive",
              )
            ).rows[0].n,
            0,
          );
          const newEvent = (
            await connection.query(
              "INSERT INTO domain.retention_event(operation) VALUES('SYNTHETIC_REVIEW') RETURNING id::text",
            )
          ).rows[0].id;
          assert.ok(BigInt(newEvent) > 70n);
        } finally {
          connection.release();
        }
      },
    );
    await t.test(
      "known event ID collisions and mismatching subjects cannot suppress different records",
      async () => {
        const action = checkpoint.actions[0];
        assert.ok(action);
        const changed = {
          ...checkpoint,
          actions: [{ ...action, subjectId: "different-subject" }],
        };
        const connection = await migration.connect();
        try {
          await assert.rejects(
            reconcilePrivacyCheckpoint(
              connection,
              changed,
              "b".repeat(64),
              "Controlled review",
            ),
            /collision|inconsistent/,
          );
        } finally {
          connection.release();
        }
        await migration.query(
          "INSERT INTO domain.retention_event(id,operation) OVERRIDING SYSTEM VALUE VALUES(100,'SYNTHETIC_OTHER_EVENT')",
        );
        const collision: PrivacyCheckpoint = {
          ...checkpoint,
          ledgerHead: "100",
          actions: [
            ...checkpoint.actions,
            {
              ...action,
              id: "100",
              action: "ERASE",
              archiveDestroyed: false,
              archiveId: null,
              destroyAfter: null,
            },
          ],
        };
        const second = await migration.connect();
        try {
          await assert.rejects(
            reconcilePrivacyCheckpoint(
              second,
              collision,
              "c".repeat(64),
              "Controlled review",
            ),
            /collision|inconsistent/,
          );
        } finally {
          second.release();
        }
        assert.equal(
          (
            await migration.query(
              "SELECT operation FROM domain.retention_event WHERE id=100",
            )
          ).rows[0].operation,
          "SYNTHETIC_OTHER_EVENT",
        );
      },
    );
    await t.test(
      "missing still-required blocked payload fails closed instead of fabricating recovered evidence",
      async () => {
        const action = checkpoint.actions[0];
        assert.ok(action);
        const missing: PrivacyCheckpoint = {
          ...checkpoint,
          ledgerHead: "101",
          actions: [
            ...checkpoint.actions,
            {
              ...action,
              id: "101",
              archiveDestroyed: false,
              archiveId: randomUUID(),
              destroyAfter: new Date(Date.now() + 86400000).toISOString(),
              targetKey: "absent-subject",
              subjectId: "absent-subject",
            },
          ],
        };
        const connection = await migration.connect();
        try {
          await assert.rejects(
            reconcilePrivacyCheckpoint(
              connection,
              missing,
              "d".repeat(64),
              "Controlled review",
            ),
            /blocked evidence missing/,
          );
        } finally {
          connection.release();
        }
        assert.equal(
          (
            await migration.query(
              "SELECT 1 FROM domain.retention_event WHERE id=101",
            )
          ).rowCount,
          0,
        );
        assert.equal(
          (
            await migration.query(
              "SELECT restore_review_required FROM domain.retention_control WHERE id",
            )
          ).rows[0].restore_review_required,
          true,
        );
      },
    );
  });
});

test("privacy replay preserves expired blocked evidence under legal hold", {
  timeout: 60000,
}, async (t) => {
  await withDatabase(async ({ migration }) => {
    const subject = "held-checkpoint-subject";
    const tenant = randomUUID();
    const archive = randomUUID();
    const hold = randomUUID();
    const createdAt = new Date(Date.now() - 30 * 86400000).toISOString();
    const cutoff = new Date(Date.now() - 86400000).toISOString();
    const blockedAt = new Date(Date.now() - 3 * 86400000).toISOString();
    const destroyAfter = new Date(Date.now() - 2 * 86400000).toISOString();
    await migration.query(
      `INSERT INTO auth."user"(id,name,email,"emailVerified","updatedAt") VALUES($1,'Synthetic','held-checkpoint@example.test',true,now())`,
      [subject],
    );
    await migration.query(
      "INSERT INTO domain.municipality(id,name,timezone) VALUES($1,'Synthetic','Europe/Madrid')",
      [tenant],
    );
    await migration.query(
      "INSERT INTO domain.municipal_profile(tenant_id,account_id,created_at) VALUES($1,$2,$3)",
      [tenant, subject, createdAt],
    );
    const payload = await command(migration, undefined, async (client) => {
      const result = (
        await client.query(
          "SELECT domain.retention_apply($1,'MUNICIPAL_PROFILE',$2,$3) result",
          [tenant, subject, cutoff],
        )
      ).rows[0].result;
      assert.equal(result.status, "APPLIED");
      await client.query(
        `INSERT INTO domain.retention_event(id,operation,tenant_id,category,target_key,subject_id,action,authorization_reference,occurred_at,details)
        OVERRIDING SYSTEM VALUE VALUES(41,'RIGHTS_ACTION_APPLIED',$1,'MUNICIPAL_PROFILE',$2,$2,'BLOCK','External rights authority',$3,$4)`,
        [tenant, subject, blockedAt, JSON.stringify({ cutoff })],
      );
      await client.query(
        `INSERT INTO domain.retention_archive(id,event_id,tenant_id,category,target_key,subject_id,payload,blocked_at,destroy_after)
        VALUES($1,41,$2,'MUNICIPAL_PROFILE',$3,$3,$4,$5,$6)`,
        [
          archive,
          tenant,
          subject,
          JSON.stringify(result.payload),
          blockedAt,
          destroyAfter,
        ],
      );
      await client.query(
        `INSERT INTO domain.retention_hold(id,tenant_id,category,subject_id,authority_reference,reason,created_by)
        VALUES($1,$2,'MUNICIPAL_PROFILE',$3,'Verified legal hold','Evidence remains required',$3)`,
        [hold, tenant, subject],
      );
      return result.payload;
    });
    const connection = await migration.connect();
    try {
      const checkpoint = await exportPrivacyCheckpoint(connection);
      assert.equal(checkpoint.actions[0]?.archiveDestroyed, false);
      assert.equal(checkpoint.actions[0]?.archiveId, archive);
      assert.equal(checkpoint.holds[0]?.id, hold);
      assert.ok(
        Date.parse(checkpoint.actions[0]?.destroyAfter ?? "") < Date.now(),
      );
      await connection.query(
        "UPDATE domain.retention_control SET restore_review_required=true WHERE id",
      );
      const assertRetained = async () => {
        const archived = (
          await connection.query(
            "SELECT id,payload,destroy_after FROM domain.retention_archive WHERE event_id=41",
          )
        ).rows[0];
        assert.equal(archived?.id, archive);
        assert.deepEqual(archived?.payload, payload);
        assert.equal(archived?.destroy_after.toISOString(), destroyAfter);
        assert.equal(
          (
            await connection.query(
              "SELECT count(*)::int n FROM domain.retention_hold WHERE id=$1 AND released_at IS NULL",
              [hold],
            )
          ).rows[0].n,
          1,
        );
        assert.equal(
          (
            await connection.query(
              "SELECT count(*)::int n FROM domain.retention_event WHERE operation='ARCHIVE_DESTROYED'",
            )
          ).rows[0].n,
          0,
        );
        assert.equal(
          (
            await connection.query(
              "SELECT restore_review_required FROM domain.retention_control WHERE id",
            )
          ).rows[0].restore_review_required,
          true,
        );
        const exported = await exportPrivacyCheckpoint(connection);
        assert.deepEqual(exported.actions, checkpoint.actions);
      };
      await t.test(
        "a snapshot already containing the archive and hold reconciles without another suppression",
        async () => {
          const result = await reconcilePrivacyCheckpoint(
            connection,
            checkpoint,
            "e".repeat(64),
            "Controlled held evidence recovery",
          );
          assert.equal(result.replayed, 0);
          assert.equal(result.reopeningAuthorized, false);
          await assertRetained();
        },
      );
      await t.test(
        "a snapshot containing the archive before the hold preserves evidence and imports the hold",
        async () => {
          await connection.query(
            "DELETE FROM domain.retention_hold WHERE id=$1",
            [hold],
          );
          await reconcilePrivacyCheckpoint(
            connection,
            checkpoint,
            "e".repeat(64),
            "Controlled pre-hold recovery",
          );
          await assertRetained();
        },
      );
      await t.test(
        "a snapshot before blocking recreates the evidence and repeated replay keeps it",
        async () => {
          await connection.query(
            "DELETE FROM domain.retention_hold; DELETE FROM domain.retention_archive; DELETE FROM domain.retention_event",
          );
          await connection.query(
            "INSERT INTO domain.municipal_profile(tenant_id,account_id,created_at) VALUES($1,$2,$3)",
            [tenant, subject, createdAt],
          );
          const first = await reconcilePrivacyCheckpoint(
            connection,
            checkpoint,
            "e".repeat(64),
            "Controlled pre-block recovery",
          );
          assert.equal(first.replayed, 1);
          await assertRetained();
          const repeated = await reconcilePrivacyCheckpoint(
            connection,
            checkpoint,
            "e".repeat(64),
            "Controlled repeated recovery",
          );
          assert.equal(repeated.replayed, 0);
          await assertRetained();
        },
      );
      await t.test(
        "a hold still prevents withdrawing a restored live target",
        async () => {
          await connection.query(
            "INSERT INTO domain.municipal_profile(tenant_id,account_id,created_at) VALUES($1,$2,$3)",
            [tenant, subject, createdAt],
          );
          await assert.rejects(
            reconcilePrivacyCheckpoint(
              connection,
              checkpoint,
              "e".repeat(64),
              "Controlled conflicting recovery",
            ),
            /conflicts with suppression evidence/,
          );
          assert.equal(
            (
              await connection.query(
                "SELECT 1 FROM domain.municipal_profile WHERE tenant_id=$1 AND account_id=$2",
                [tenant, subject],
              )
            ).rowCount,
            1,
          );
          await assertRetained();
        },
      );
    } finally {
      connection.release();
    }
  });
});
