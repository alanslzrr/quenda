import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { initializeOperator } from "../../scripts/lib/initialize-operator.ts";
import { transaction } from "../../src/database/transaction.ts";
import { requireOperator } from "../../src/modules/identity/index.ts";
import { withDatabase } from "../helpers/postgres.ts";

test("first operator initialization is controlled, auditable and not a web privilege", {
  timeout: 60000,
}, async (t) => {
  await withDatabase(async ({ auth, domain, migration }) => {
    await auth.query(`INSERT INTO auth."user" (id, name, email, "emailVerified", "createdAt", "updatedAt", "twoFactorEnabled") VALUES
      ('verified', 'Synthetic', 'verified@example.test', true, now(), now(), true),
      ('unverified', 'Synthetic', 'unverified@example.test', false, now(), now(), true),
      ('without-mfa', 'Synthetic', 'without-mfa@example.test', true, now(), now(), false)`);
    const client = await migration.connect();
    const identity = {
      accountId: "verified",
      email: "verified@example.test",
      sessionId: "synthetic-session",
      mfaVerifiedAt: new Date(),
    };
    const context = { accountId: identity.accountId, tenantId: null };
    try {
      await t.test(
        "rejects absent, unverified and non-MFA accounts without partial initialization",
        async () => {
          for (const account of ["absent", "unverified", "without-mfa"]) {
            await assert.rejects(
              initializeOperator(client, account),
              /verified account with MFA/,
            );
          }
          assert.equal(
            (await client.query("SELECT * FROM domain.platform_operator"))
              .rowCount,
            0,
          );
          assert.equal(
            (await client.query("SELECT * FROM domain.operator_initialization"))
              .rowCount,
            0,
          );
        },
      );
      await t.test(
        "initializes exactly once and records the operation atomically",
        async () => {
          await initializeOperator(client, identity.accountId);
          const evidence = await client.query(
            "SELECT account_id, operation, occurred_at FROM domain.operator_initialization",
          );
          assert.equal(evidence.rowCount, 1);
          assert.equal(evidence.rows[0].account_id, identity.accountId);
          assert.equal(evidence.rows[0].operation, "INITIALIZE_OPERATOR");
          assert.ok(evidence.rows[0].occurred_at instanceof Date);
          await assert.rejects(
            initializeOperator(client, identity.accountId),
            /already completed/,
          );
        },
      );
      await t.test(
        "runtime cannot assign or restore operators, and cannot read without account scope",
        async () => {
          assert.equal(
            (await domain.query("SELECT * FROM domain.platform_operator"))
              .rowCount,
            0,
          );
          for (const sql of [
            "INSERT INTO domain.platform_operator (account_id) VALUES ('without-mfa')",
            "UPDATE domain.platform_operator SET revoked_at = NULL",
            "DELETE FROM domain.operator_initialization",
          ]) {
            await assert.rejects(domain.query(sql), { code: "42501" });
          }
          await transaction(
            domain,
            async (connection) => {
              assert.equal(
                (
                  await connection.query(
                    "SELECT * FROM domain.platform_operator",
                  )
                ).rowCount,
                1,
              );
              await requireOperator(connection, identity);
              await assert.rejects(
                requireOperator(connection, {
                  ...identity,
                  mfaVerifiedAt: null,
                }),
                { code: "FORBIDDEN" },
              );
              await assert.rejects(
                requireOperator(connection, {
                  ...identity,
                  accountId: "without-mfa",
                }),
                { code: "FORBIDDEN" },
              );
            },
            context,
          );
          await assert.rejects(
            transaction(domain, (connection) =>
              requireOperator(connection, identity),
            ),
            { code: "FORBIDDEN" },
          );
        },
      );
      await t.test(
        "revocation denies the next command and does not reopen initialization",
        async () => {
          const updater = await migration.connect();
          let unlock!: () => void;
          let authorized!: () => void;
          const gate = new Promise<void>((resolve) => {
            unlock = resolve;
          });
          const ready = new Promise<void>((resolve) => {
            authorized = resolve;
          });
          const running = transaction(
            domain,
            async (connection) => {
              await requireOperator(connection, identity);
              authorized();
              await gate;
            },
            context,
          );
          let update: Promise<unknown> | undefined;
          try {
            await ready;
            const pid = (await updater.query("SELECT pg_backend_pid() AS pid"))
              .rows[0].pid;
            update = updater.query(
              "UPDATE domain.platform_operator SET revoked_at = now() WHERE account_id = $1",
              [identity.accountId],
            );
            let blocked = false;
            for (let attempt = 0; attempt < 100; attempt++) {
              const state = await client.query(
                "SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1",
                [pid],
              );
              if (state.rows[0]?.wait_event_type === "Lock") {
                blocked = true;
                break;
              }
              await setTimeout(10);
            }
            assert.equal(
              blocked,
              true,
              "Revocation must wait for the authorized command",
            );
          } finally {
            unlock();
            await running;
            await update;
            updater.release();
          }
          await assert.rejects(
            transaction(
              domain,
              (connection) => requireOperator(connection, identity),
              context,
            ),
            { code: "FORBIDDEN" },
          );
          await assert.rejects(
            initializeOperator(client, identity.accountId),
            /already completed/,
          );
        },
      );
    } finally {
      client.release();
    }
  });
});
