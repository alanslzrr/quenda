import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { Client, Pool } from "pg";
import { createBackup } from "../../scripts/lib/backup.ts";
import {
  exportPrivacyCheckpoint,
  readPrivacyCheckpoint,
  reconcilePrivacyCheckpoint,
  writePrivacyCheckpoint,
} from "../../scripts/lib/privacy-checkpoint.ts";
import { restoreBackup } from "../../scripts/lib/restore.ts";
import { assertPrivacyOperational } from "../../src/database/pools.ts";
import { processRetentionBatch } from "../../src/modules/identity/retention-worker.ts";
import { withDatabase } from "../helpers/postgres.ts";

test("an older backup stays closed and suppression replay remains durable across later checkpoints", {
  timeout: 60000,
}, async () => {
  await withDatabase(
    async ({ root, auth, migration, administration, domain, worker }) => {
      await auth.query(
        `INSERT INTO auth."user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES('subject','Subject','subject@example.test',true,now(),now())`,
      );
      const a = randomUUID(),
        b = randomUUID();
      for (const tenant of [a, b]) {
        await migration.query(
          "INSERT INTO domain.municipality(id,name,timezone) VALUES($1,'Synthetic','Europe/Madrid')",
          [tenant],
        );
        await migration.query(
          "INSERT INTO domain.municipal_profile(tenant_id,account_id,created_at) VALUES($1,'subject',now()-interval '30 days')",
          [tenant],
        );
        await migration.query(
          `INSERT INTO domain.retention_policy(id,tenant_id,category,retention_days,action,block_days,purpose,controller_reference,approval_reference,reason,approved_by)
        VALUES($1,$2,'MUNICIPAL_PROFILE',1,$3,$4,'Synthetic test purpose','Synthetic controller','Synthetic approval','Fixture','subject')`,
          [
            randomUUID(),
            tenant,
            tenant === a ? "BLOCK" : "ERASE",
            tenant === a ? 30 : null,
          ],
        );
      }
      const source = administration.options.connectionString as string;
      const current = new Client({ connectionString: source });
      await current.connect();
      try {
        const empty = await exportPrivacyCheckpoint(current);
        const backup = await createBackup(
          source,
          path.join(root, "old.dump"),
          process.env.PG_BIN as string,
        );
        assert.equal((await processRetentionBatch(worker)).processed, 2);
        assert.equal(
          (
            await migration.query(
              "SELECT count(*)::int n FROM domain.municipal_profile",
            )
          ).rows[0].n,
          0,
        );
        assert.equal(
          (
            await migration.query(
              "SELECT count(*)::int n FROM domain.retention_archive",
            )
          ).rows[0].n,
          1,
        );
        const checkpointFile = await writePrivacyCheckpoint(
          current,
          path.join(root, "privacy.json"),
        );
        await assert.rejects(
          readPrivacyCheckpoint(checkpointFile.path, "0".repeat(64)),
          /checksum/,
        );
        const checkpoint = await readPrivacyCheckpoint(
          checkpointFile.path,
          checkpointFile.sha256,
        );
        assert.equal(checkpoint.actions.length, 2);
        await restoreBackup(
          source,
          backup.path,
          backup.sha256,
          "privacy_closed",
          process.env.PG_BIN as string,
        );
        const url = new URL(source);
        url.pathname = "/privacy_closed";
        const restored = new Client({ connectionString: url.toString() });
        await restored.connect();
        try {
          assert.equal(
            (await restored.query("SELECT domain.privacy_operational() ready"))
              .rows[0].ready,
            false,
          );
          assert.equal(
            (
              await restored.query(
                "SELECT count(*)::int n FROM domain.municipal_profile",
              )
            ).rows[0].n,
            2,
          );
          await assert.rejects(
            reconcilePrivacyCheckpoint(
              restored,
              { ...checkpoint, instanceId: randomUUID() },
              checkpointFile.sha256,
              "Synthetic recovery",
            ),
            /instance/,
          );
          const report = await reconcilePrivacyCheckpoint(
            restored,
            checkpoint,
            checkpointFile.sha256,
            "Synthetic recovery",
          );
          assert.equal(report.reopeningAuthorized, false);
          assert.equal(
            (
              await restored.query(
                "SELECT count(*)::int n FROM domain.municipal_profile",
              )
            ).rows[0].n,
            0,
          );
          assert.equal(
            (
              await restored.query(
                "SELECT count(*)::int n FROM domain.retention_archive",
              )
            ).rows[0].n,
            1,
          );
          const next = await exportPrivacyCheckpoint(restored);
          assert.equal(
            next.actions.length,
            2,
            "a second checkpoint must not forget replayed suppression",
          );
          await reconcilePrivacyCheckpoint(
            restored,
            checkpoint,
            checkpointFile.sha256,
            "Synthetic recovery retry",
          );
          assert.equal(
            (
              await restored.query(
                "SELECT count(*)::int n FROM domain.retention_archive",
              )
            ).rows[0].n,
            1,
          );
          await assert.rejects(
            reconcilePrivacyCheckpoint(
              restored,
              empty,
              "f".repeat(64),
              "Stale evidence",
            ),
            /predates|mismatch|known/,
          );
          assert.equal(
            (await restored.query("SELECT domain.privacy_operational() ready"))
              .rows[0].ready,
            false,
          );
          await administration.query(
            "ALTER DATABASE privacy_closed CONNECTION LIMIT -1",
          );
          await administration.query(
            "GRANT CONNECT ON DATABASE privacy_closed TO quenda_domain",
          );
          const runtimeUrl = new URL(domain.options.connectionString as string);
          runtimeUrl.pathname = "/privacy_closed";
          const runtime = new Pool({ connectionString: runtimeUrl.toString() });
          try {
            await assert.rejects(
              assertPrivacyOperational(runtime),
              /Privacy recovery review/,
            );
          } finally {
            await runtime.end();
          }
        } finally {
          await restored.end();
        }
      } finally {
        await current.end();
      }
    },
  );
});
