import assert from "node:assert/strict";
import test from "node:test";
import { command } from "../../src/database/command.ts";
import { transaction } from "../../src/database/transaction.ts";
import { withDatabase } from "../helpers/postgres.ts";

const tenantA = "00000000-0000-4000-8000-000000000001";
const tenantB = "00000000-0000-4000-8000-000000000002";
const scope = { accountId: "account-a", tenantId: tenantA };

test("transaction context and bounded full-command retries", {
  timeout: 60000,
}, async (t) => {
  await withDatabase(async ({ domain, migration, auth }) => {
    for (const id of ["account-a", "account-b"])
      await auth.query(
        'INSERT INTO auth."user"(id,name,email,"emailVerified") VALUES($1,$1,$2,true)',
        [id, `${id}@example.test`],
      );
    // A fixture tests the infrastructure contract, not municipal authorization.
    await migration.query(`
      CREATE TABLE domain.context_probe (tenant_id uuid, account_id text, value integer NOT NULL, PRIMARY KEY(tenant_id, account_id));
      INSERT INTO domain.context_probe VALUES ('${tenantA}', 'account-a', 0), ('${tenantB}', 'account-b', 0);
      ALTER TABLE domain.context_probe ENABLE ROW LEVEL SECURITY;
      ALTER TABLE domain.context_probe FORCE ROW LEVEL SECURITY;
      CREATE POLICY scope ON domain.context_probe TO quenda_domain
        USING (tenant_id = nullif(current_setting('quenda.tenant_id', true), '')::uuid
          AND account_id = nullif(current_setting('quenda.account_id', true), ''))
        WITH CHECK (tenant_id = nullif(current_setting('quenda.tenant_id', true), '')::uuid
          AND account_id = nullif(current_setting('quenda.account_id', true), ''));
      GRANT SELECT, INSERT, UPDATE ON domain.context_probe TO quenda_domain;
    `);
    domain.options.max = 1;
    const read = async () =>
      transaction(
        domain,
        async (client) =>
          (await client.query("SELECT * FROM domain.context_probe")).rows,
        scope,
      );
    await t.test(
      "commit and rollback clear context on the same pooled connection; absent scope fails closed",
      async () => {
        const pid = (await domain.query("SELECT pg_backend_pid() AS pid"))
          .rows[0].pid;
        assert.equal(
          (await domain.query("SELECT * FROM domain.context_probe")).rowCount,
          0,
        );
        assert.equal((await read()).length, 1);
        assert.equal(
          (await domain.query("SELECT pg_backend_pid() AS pid")).rows[0].pid,
          pid,
        );
        assert.equal(
          (await domain.query("SELECT * FROM domain.context_probe")).rowCount,
          0,
        );
        await assert.rejects(
          transaction(
            domain,
            async (client) => {
              assert.equal(
                (await client.query("SELECT * FROM domain.context_probe"))
                  .rowCount,
                1,
              );
              throw new Error("Abort");
            },
            { accountId: "account-b", tenantId: tenantB },
          ),
          /Abort/,
        );
        assert.equal(
          (await domain.query("SELECT * FROM domain.context_probe")).rowCount,
          0,
        );
        assert.equal(
          await transaction(
            domain,
            async (client) =>
              (await client.query("SELECT * FROM domain.context_probe"))
                .rowCount,
          ),
          0,
        );
        await assert.rejects(
          transaction(
            domain,
            async (client) => {
              await client.query(
                "INSERT INTO domain.context_probe VALUES ($1, 'intruder', 1)",
                [tenantB],
              );
            },
            scope,
          ),
          { code: "42501" },
        );
        assert.equal(
          (await domain.query("SELECT pg_backend_pid() AS pid")).rows[0].pid,
          pid,
        );
      },
    );
    await t.test(
      "retries serialization and deadlock errors three times, rolling back every failed attempt",
      async () => {
        for (const code of ["40001", "40P01"]) {
          let attempts = 0;
          await assert.rejects(
            command(domain, scope, async (client) => {
              attempts++;
              assert.equal(
                (await client.query("SELECT * FROM domain.context_probe"))
                  .rowCount,
                1,
              );
              await client.query(
                "UPDATE domain.context_probe SET value = value + 1",
              );
              await client.query(
                `DO $$ BEGIN RAISE EXCEPTION 'forced retry' USING ERRCODE = '${code}'; END $$`,
              );
            }),
            { code },
          );
          assert.equal(attempts, 3);
          assert.equal((await read())[0].value, 0);
        }
        let attempts = 0;
        await assert.rejects(
          command(domain, scope, async (client) => {
            attempts++;
            await client.query(
              "INSERT INTO domain.context_probe VALUES ($1, $2, 0)",
              [tenantA, scope.accountId],
            );
          }),
          { code: "23505" },
        );
        assert.equal(attempts, 1);
      },
    );
    await t.test(
      "real concurrent writes rerun reads under a fresh snapshot without lost updates",
      async () => {
        domain.options.max = 5;
        let arrived = 0;
        let release!: () => void;
        const barrier = new Promise<void>((resolve) => {
          release = resolve;
        });
        const attempts = [0, 0];
        await Promise.all(
          [0, 1].map((index) =>
            command(domain, scope, async (client) => {
              attempts[index] = (attempts[index] ?? 0) + 1;
              const value = (
                await client.query("SELECT value FROM domain.context_probe")
              ).rows[0].value;
              if (attempts[index] === 1) {
                arrived++;
                if (arrived === 2) release();
                await barrier;
              }
              await client.query("UPDATE domain.context_probe SET value = $1", [
                value + 1,
              ]);
            }),
          ),
        );
        assert.equal(
          attempts.reduce((a, b) => a + b, 0),
          3,
        );
        assert.equal((await read())[0].value, 2);
        assert.equal(
          (await domain.query("SELECT * FROM domain.context_probe")).rowCount,
          0,
        );
      },
    );
  });
});
