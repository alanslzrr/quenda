import assert from "node:assert/strict";
import test from "node:test";
import {
  consumeAdministrativeAttempt,
  consumeReadAttempt,
} from "../../src/modules/identity/index.ts";
import { withDatabase } from "../helpers/postgres.ts";

test("administrative limits are atomic, bounded and database-shared", {
  timeout: 60000,
}, async () => {
  await withDatabase(async ({ domain, auth, migration }) => {
    for (const id of ["limited", "independent"])
      await auth.query(
        'INSERT INTO auth."user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ($1, $1, $2, true, now(), now())',
        [id, `${id}@example.test`],
      );
    const decisions = await Promise.all(
      Array.from({ length: 124 }, () =>
        consumeAdministrativeAttempt(domain, "limited"),
      ),
    );
    assert.equal(decisions.filter((d) => d.allowed).length, 120);
    assert.equal(decisions.filter((d) => !d.allowed).length, 4);
    assert.ok(decisions.every((d) => d.retryAfter >= 1 && d.retryAfter <= 60));
    assert.equal(
      (await consumeAdministrativeAttempt(domain, "independent")).allowed,
      true,
    );
    assert.equal(
      (
        await migration.query(
          "SELECT attempts FROM domain.administrative_rate_limit WHERE account_id = 'limited'",
        )
      ).rows[0].attempts,
      121,
    );
    await assert.rejects(
      domain.query("SELECT * FROM domain.administrative_rate_limit"),
      { code: "42501" },
    );
    await assert.rejects(
      domain.query("DELETE FROM domain.administrative_rate_limit"),
      { code: "42501" },
    );
    await migration.query(
      "UPDATE domain.administrative_rate_limit SET window_started_at = now() - interval '61 seconds' WHERE account_id = 'limited'",
    );
    assert.equal(
      (await consumeAdministrativeAttempt(domain, "limited")).allowed,
      true,
    );
    assert.equal(
      (
        await migration.query(
          "SELECT attempts FROM domain.administrative_rate_limit WHERE account_id = 'limited'",
        )
      ).rows[0].attempts,
      1,
    );
  });
});

test("reads have their own larger budget, so browsing never blocks commands", {
  timeout: 60000,
}, async () => {
  await withDatabase(async ({ domain, auth, migration }) => {
    await auth.query(
      'INSERT INTO auth."user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ($1, $1, $2, true, now(), now())',
      ["reader", "reader@example.test"],
    );
    const reads = await Promise.all(
      Array.from({ length: 604 }, () => consumeReadAttempt(domain, "reader")),
    );
    assert.equal(reads.filter((d) => d.allowed).length, 600);
    assert.ok(
      reads
        .filter((d) => !d.allowed)
        .every((d) => d.retryAfter >= 1 && d.retryAfter <= 60),
    );
    // An exhausted read budget leaves the command budget untouched.
    assert.equal(
      (await consumeAdministrativeAttempt(domain, "reader")).allowed,
      true,
    );
    assert.equal(
      (
        await migration.query(
          "SELECT attempts FROM domain.read_rate_limit WHERE account_id = 'reader'",
        )
      ).rows[0].attempts,
      601,
    );
    await assert.rejects(domain.query("SELECT * FROM domain.read_rate_limit"), {
      code: "42501",
    });
    await migration.query(
      "UPDATE domain.read_rate_limit SET window_started_at = now() - interval '61 seconds' WHERE account_id = 'reader'",
    );
    assert.equal((await consumeReadAttempt(domain, "reader")).allowed, true);
  });
});
