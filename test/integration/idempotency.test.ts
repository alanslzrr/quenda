import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  commandFingerprint,
  idempotentCommand,
} from "../../src/database/idempotency.ts";
import { transaction } from "../../src/database/transaction.ts";
import { HttpError } from "../../src/http/errors.ts";
import { withDatabase } from "../helpers/postgres.ts";

test("idempotent commands commit results with effects and reauthorize replay", {
  timeout: 60000,
}, async (t) => {
  await withDatabase(async ({ domain, auth, migration }) => {
    const tenantId = randomUUID();
    await auth.query(
      `INSERT INTO auth."user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES('actor','Actor','actor@example.test',true,now(),now()),('other','Other','other@example.test',true,now(),now())`,
    );
    await migration.query(
      "INSERT INTO domain.municipality(id,name,timezone) VALUES($1,'Synthetic','Europe/Madrid')",
      [tenantId],
    );
    await migration.query(
      "CREATE TABLE domain.effect_probe(id uuid PRIMARY KEY); GRANT SELECT,INSERT ON domain.effect_probe TO quenda_domain",
    );
    const context = { tenantId, accountId: "actor" };
    let allowed = true,
      authorizations = 0;
    const options = {
      operation: "reservation.create",
      key: "request-1",
      input: { unit: "a", start: "2030-01-01T10:00Z" },
      retentionSeconds: 3600,
      authorize: async () => {
        authorizations++;
        if (!allowed) throw new HttpError("FORBIDDEN");
      },
      execute: async (c: import("pg").PoolClient) => {
        const id = randomUUID();
        await c.query("INSERT INTO domain.effect_probe VALUES($1)", [id]);
        return { id };
      },
    };
    await t.test(
      "response loss replays the original result; changed input and revoked access are rejected",
      async () => {
        const first = await idempotentCommand(domain, context, options);
        const second = await idempotentCommand(domain, context, {
          ...options,
          input: { start: options.input.start, unit: "a" },
        });
        assert.equal(first.replayed, false);
        assert.equal(second.replayed, true);
        assert.deepEqual(second.result, first.result);
        assert.equal(first.expiresAt, second.expiresAt);
        assert.equal(authorizations, 2);
        await assert.rejects(
          idempotentCommand(domain, context, {
            ...options,
            input: { ...options.input, unit: "b" },
          }),
          { code: "CONFLICT" },
        );
        allowed = false;
        await assert.rejects(idempotentCommand(domain, context, options), {
          code: "FORBIDDEN",
        });
        allowed = true;
        assert.equal(
          (
            await migration.query(
              "SELECT count(*)::int AS n FROM domain.effect_probe",
            )
          ).rows[0].n,
          1,
        );
      },
    );
    await t.test(
      "concurrent duplicate commands produce one effect",
      async () => {
        const results = await Promise.all(
          Array.from({ length: 12 }, () =>
            idempotentCommand(domain, context, {
              ...options,
              key: "concurrent",
            }),
          ),
        );
        assert.equal(results.filter((r) => !r.replayed).length, 1);
        assert.equal(new Set(results.map((r) => r.result.id)).size, 1);
        assert.equal(
          (
            await migration.query(
              "SELECT count(*)::int AS n FROM domain.effect_probe",
            )
          ).rows[0].n,
          2,
        );
      },
    );
    await t.test(
      "failed commands roll back both claim and effects and can be retried",
      async () => {
        await assert.rejects(
          idempotentCommand(domain, context, {
            ...options,
            key: "rollback",
            execute: async (c) => {
              await options.execute(c);
              throw new Error("Abort");
            },
          }),
          /Abort/,
        );
        assert.equal(
          (
            await migration.query(
              "SELECT count(*)::int AS n FROM domain.idempotent_command WHERE key='rollback'",
            )
          ).rows[0].n,
          0,
        );
        assert.equal(
          (
            await migration.query(
              "SELECT count(*)::int AS n FROM domain.effect_probe",
            )
          ).rows[0].n,
          2,
        );
        assert.equal(
          (
            await idempotentCommand(domain, context, {
              ...options,
              key: "rollback",
            })
          ).replayed,
          false,
        );
      },
    );
    await t.test(
      "expired results allow a new command; scopes and JSON null remain distinct",
      async () => {
        await migration.query(
          "UPDATE domain.idempotent_command SET created_at=now()-interval '2 hours',expires_at=now()-interval '1 hour' WHERE key='request-1'",
        );
        const fresh = await idempotentCommand(domain, context, {
          ...options,
          input: { ...options.input, unit: "b" },
        });
        assert.equal(fresh.replayed, false);
        const other = await idempotentCommand(
          domain,
          { ...context, accountId: "other" },
          options,
        );
        assert.equal(other.replayed, false);
        const operation = await idempotentCommand(domain, context, {
          ...options,
          operation: "reservation.modify",
        });
        assert.equal(operation.replayed, false);
        const otherTenant = randomUUID();
        await migration.query(
          "INSERT INTO domain.municipality(id,name,timezone) VALUES($1,'Second','Europe/Madrid')",
          [otherTenant],
        );
        const crossTenant = await idempotentCommand(
          domain,
          { ...context, tenantId: otherTenant },
          options,
        );
        assert.equal(crossTenant.replayed, false);
        assert.notEqual(crossTenant.result.id, fresh.result.id);
        await transaction(
          domain,
          async (c) => {
            const visible = await c.query(
              "SELECT tenant_id FROM domain.idempotent_command",
            );
            assert.equal(visible.rowCount, 1);
            assert.equal(visible.rows[0].tenant_id, otherTenant);
          },
          { ...context, tenantId: otherTenant },
        );
        const nil = { ...options, key: "null", execute: async () => null };
        assert.equal(
          (await idempotentCommand(domain, context, nil)).replayed,
          false,
        );
        assert.deepEqual(
          (await idempotentCommand(domain, context, nil)).result,
          null,
        );
        assert.equal(
          (await idempotentCommand(domain, context, nil)).replayed,
          true,
        );
      },
    );
    await t.test(
      "an incomplete claim cannot commit; RLS hides other actors and absent context",
      async () => {
        await assert.rejects(
          transaction(
            domain,
            (c) =>
              c.query(
                `INSERT INTO domain.idempotent_command(tenant_id,actor_id,operation,key,fingerprint,created_at,expires_at) VALUES($1,'actor','create','incomplete',$2,now(),now()+interval '1 hour')`,
                [tenantId, commandFingerprint({})],
              ),
            context,
          ),
          { code: "23514" },
        );
        assert.equal(
          (await domain.query("SELECT * FROM domain.idempotent_command"))
            .rowCount,
          0,
        );
        await transaction(
          domain,
          async (c) => {
            const rows = await c.query(
              "SELECT actor_id FROM domain.idempotent_command",
            );
            assert.ok(rows.rows.every((r) => r.actor_id === "other"));
            assert.equal(rows.rowCount, 1);
          },
          { ...context, accountId: "other" },
        );
        await assert.rejects(
          transaction(
            domain,
            (c) => c.query("DELETE FROM domain.idempotent_command"),
            context,
          ),
          { code: "42501" },
        );
      },
    );
    await t.test(
      "duplicate lock waits are bounded without cancelling the original command",
      async () => {
        let release!: () => void, started!: () => void;
        const barrier = new Promise<void>((r) => {
          release = r;
        });
        const ready = new Promise<void>((r) => {
          started = r;
        });
        const first = idempotentCommand(domain, context, {
          ...options,
          key: "slow",
          execute: async (c) => {
            started();
            await barrier;
            return options.execute(c);
          },
        });
        await ready;
        try {
          await assert.rejects(
            idempotentCommand(domain, context, { ...options, key: "slow" }),
            { code: "CONFLICT" },
          );
        } finally {
          release();
        }
        const result = await first;
        assert.equal(result.replayed, false);
        assert.equal(
          (
            await idempotentCommand(domain, context, {
              ...options,
              key: "slow",
            })
          ).replayed,
          true,
        );
      },
    );
  });
});
