import assert from "node:assert/strict";
import test from "node:test";
import type { Client } from "pg";
import { bootstrap } from "../../scripts/lib/bootstrap.ts";
import { provisionWorker } from "../../scripts/lib/provision-worker.ts";
import { scramVerifier } from "../../scripts/lib/scram-verifier.ts";

test("role provisioning never sends plaintext passwords as SQL or parameters", async () => {
  const secrets = {
    migration: "migration-secret-0123456789",
    domain: "domain-secret-0123456789012",
    auth: "auth-secret-012345678901234",
    worker: "worker-secret-0123456789012",
  };
  let verifiers = 0;
  const client = {
    query: async (sql: string, parameters?: unknown[]) => {
      const sent = JSON.stringify([sql, parameters]);
      for (const secret of Object.values(secrets))
        assert.ok(!sent.includes(secret));
      if (sql.includes("CREATE ROLE")) {
        const verifier = parameters?.at(-1);
        assert.equal(typeof verifier, "string");
        assert.match(
          String(verifier),
          /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/]+=*\$[A-Za-z0-9+/]+=*:[A-Za-z0-9+/]+=*$/,
        );
        verifiers++;
      }
      return {
        rowCount: 4,
        rows: [
          {
            sql: "SELECT 1",
            revoke: "SELECT 1",
            connect: "SELECT 1",
            create: "SELECT 1",
            create_role: "SELECT 1",
          },
        ],
      };
    },
  } as unknown as Client;
  await bootstrap(client, secrets);
  await provisionWorker(client, secrets.worker);
  assert.equal(verifiers, 5);
  assert.notEqual(
    scramVerifier(secrets.auth),
    scramVerifier(secrets.auth),
    "each role receives a fresh salt",
  );
  for (const password of ["short", `${secrets.auth}\n`, `${secrets.auth}é`])
    assert.throws(() => scramVerifier(password));
});
