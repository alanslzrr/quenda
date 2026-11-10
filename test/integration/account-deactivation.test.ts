import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { Client, type Pool } from "pg";
import { migrate } from "../../scripts/lib/migrations.ts";
import { buildApp } from "../../src/app.ts";
import { transaction } from "../../src/database/transaction.ts";
import {
  createAuthentication,
  deactivateAccount,
  saveAccountPreferences,
} from "../../src/modules/identity/index.ts";
import {
  cancelReservation,
  createReservation,
} from "../../src/modules/reservations/index.ts";
import type { MailMessage } from "../../src/shared/mail.ts";
import { browser } from "../helpers/auth-client.ts";
import { withDatabase } from "../helpers/postgres.ts";
import { verifyProductResponses } from "../helpers/response-contract.ts";
import { seedUsageRules } from "../helpers/usage-rules-fixture.ts";

const account = (id: string) => ({
  accountId: id,
  email: `${id}@example.test`,
  sessionId: `session-${id}`,
  mfaVerifiedAt: null,
});

const proofDigest = (id: string) =>
  createHash("sha256").update(id).digest("hex");

// Command/concurrency fixtures model a proof already issued by the auth service.
// Actual password and MFA verification is exercised through HTTP separately.
async function seedProof(migration: Pool, id: string) {
  await migration.query(
    `INSERT INTO auth.account(id,"accountId","providerId","userId",password,"updatedAt") VALUES($1,$1,'credential',$1,'fixture-credential-hash',now()) ON CONFLICT(id) DO NOTHING`,
    [id],
  );
  await migration.query(
    `INSERT INTO auth.session(id,"expiresAt",token,"userId","updatedAt","mfaVerifiedAt") VALUES($1,now()+interval '1 day',$1,$2,now(),now()) ON CONFLICT(id) DO NOTHING`,
    [`session-${id}`, id],
  );
  await migration.query(
    `INSERT INTO auth.account_deactivation_proof(token_digest,account_id,session_id,password_hash,expires_at) VALUES($1,$2,$3,'fixture-credential-hash',clock_timestamp()+interval '5 minutes')`,
    [proofDigest(id), id, `session-${id}`],
  );
}

async function fixture(migration: Pool, actorId: string) {
  const tenantId = randomUUID(),
    facilityId = randomUUID(),
    unitId = randomUUID();
  await migration.query(
    "INSERT INTO domain.municipality(id,name,timezone) VALUES($1,'Deactivation fixture','Europe/Madrid')",
    [tenantId],
  );
  await migration.query(
    "INSERT INTO domain.facility(tenant_id,id,name,published_at) VALUES($1,$2,'Fixture',now())",
    [tenantId, facilityId],
  );
  await migration.query(
    "INSERT INTO domain.reservable_unit(tenant_id,id,facility_id,name) VALUES($1,$2,$3,'Fixture')",
    [tenantId, unitId, facilityId],
  );
  await migration.query(
    "INSERT INTO domain.unit_calendar_version(tenant_id,unit_id,version,minimum_minutes,maximum_minutes,step_minutes,weekly,exceptions,actor_id,reason) VALUES($1,$2,1,60,60,60,$3,'[]',$4,'Fixture')",
    [
      tenantId,
      unitId,
      JSON.stringify(
        Array.from({ length: 7 }, (_, i) => ({
          day: i + 1,
          startMinute: 0,
          endMinute: 1440,
        })),
      ),
      actorId,
    ],
  );
  await seedUsageRules(migration, tenantId, unitId, actorId);
  await migration.query(
    "UPDATE domain.reservable_unit SET calendar_version=1,published_at=now() WHERE tenant_id=$1 AND id=$2",
    [tenantId, unitId],
  );
  const start = new Date();
  start.setUTCDate(start.getUTCDate() + 3);
  start.setUTCHours(12, 0, 0, 0);
  return {
    tenantId,
    input: {
      unitId,
      startsAt: start.toISOString(),
      endsAt: new Date(start.getTime() + 3600000).toISOString(),
      acceptance: {
        usageRulesVersion: 1,
        bookingPolicyVersion: 1,
        nonCancellable: false,
      },
    },
  };
}

async function waitForBlockedQuery(migration: Pool, fragment: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await migration.query(
      "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE $1",
      [`%${fragment}%`],
    );
    if (result.rowCount) return;
    await setTimeout(20);
  }
  assert.fail(`No blocked query found: ${fragment}`);
}

test("account deactivation revokes every session, preserves history and rejects future reservations globally", {
  timeout: 60000,
}, async (t) => {
  await withDatabase(async ({ auth, domain, migration, worker }) => {
    const messages: MailMessage[] = [];
    const config = {
      origin: "https://quenda.test",
      secret: randomBytes(32).toString("hex"),
    };
    const mail = {
      send: async (message: MailMessage) => {
        messages.push(message);
      },
    };
    const identity = createAuthentication(auth, config, mail);
    const app = await buildApp({
      database: { check: async () => {}, close: async () => {} },
      domain,
      identity: { authentication: identity, config },
      logLevel: "silent",
    });
    const replica = await buildApp({
      database: { check: async () => {}, close: async () => {} },
      domain,
      identity: {
        authentication: createAuthentication(auth, config, mail),
        config,
      },
      logLevel: "silent",
    });
    const contracts = [app, replica].map(verifyProductResponses);
    const first = browser(app, "192.0.2.240");
    const second = browser(replica, "192.0.2.241");
    const email = "deactivation@example.test";
    const password = "Synthetic-deactivation-password-123!";
    try {
      const signup = await first.request("/api/auth/sign-up/email", {
        name: "Deactivation test",
        email,
        password,
      });
      assert.equal(signup.statusCode, 200, signup.body);
      const id = signup.json().user.id as string;
      const actor = { ...account(id), email };
      const message = messages.find((item) => item.to === email);
      assert.ok(message);
      const verification = new URL(
        message.text.trim().split("\n").at(-1) ?? "",
      );
      assert.ok(
        [200, 302].includes(
          (await first.request(verification.pathname + verification.search))
            .statusCode,
        ),
      );
      for (const client of [first, second]) {
        const login = await client.request("/api/auth/sign-in/email", {
          email,
          password,
        });
        assert.equal(login.statusCode, 200, login.body);
      }
      const firstCookie = first.cookie();
      const secondCookie = second.cookie();
      assert.equal(
        (
          await auth.query(
            'SELECT count(*)::int AS n FROM auth.session WHERE "userId"=$1',
            [id],
          )
        ).rows[0].n,
        2,
      );

      await t.test(
        "explicit confirmation and correct Origin are required",
        async () => {
          for (const body of [
            {},
            { confirm: false },
            { confirm: true, accountId: "someone-else" },
          ])
            assert.equal(
              (await first.request("/api/me/deactivation", body)).statusCode,
              400,
            );
          assert.equal(
            (
              await first.request(
                "/api/me/deactivation",
                { confirm: true, password },
                { origin: "https://other.invalid" },
              )
            ).statusCode,
            403,
          );
          const wrong = await first.request("/api/me/deactivation", {
            confirm: true,
            password: `${password}-wrong`,
          });
          assert.equal(wrong.statusCode, 403, wrong.body);
          assert.equal(wrong.json().error.code, "ACCOUNT_PASSWORD_REQUIRED");
          const bucket = `deactivation:${createHash("sha256").update(id).digest("hex")}`;
          await migration.query(
            "UPDATE auth.account_reactivation_rate_limit SET attempts=20 WHERE bucket=$1",
            [bucket],
          );
          const limited = await first.request("/api/me/deactivation", {
            confirm: true,
            password,
          });
          assert.equal(limited.statusCode, 429, limited.body);
          assert.equal(
            (
              await migration.query(
                "DELETE FROM auth.account_reactivation_rate_limit WHERE bucket=$1",
                [bucket],
              )
            ).rowCount,
            1,
          );
        },
      );

      const municipal = await fixture(migration, id);
      const otherMunicipal = await fixture(migration, id);
      const reservations: Awaited<ReturnType<typeof createReservation>>[] = [];
      for (const entry of [municipal, otherMunicipal])
        reservations.push(
          await createReservation(
            domain,
            actor,
            entry.tenantId,
            randomUUID(),
            entry.input,
            randomUUID(),
            3600,
          ),
        );

      await t.test(
        "a booking in any municipality blocks deactivation without revoking sessions",
        async () => {
          const [firstReservation, secondReservation] = reservations;
          assert.ok(firstReservation && secondReservation);
          const denied = await first.request("/api/me/deactivation", {
            confirm: true,
            password,
          });
          assert.equal(denied.statusCode, 409, denied.body);
          assert.equal(
            denied.json().error.code,
            "ACCOUNT_HAS_FUTURE_RESERVATIONS",
          );
          assert.equal(
            (
              await auth.query(
                'SELECT count(*)::int AS n FROM auth.session WHERE "userId"=$1',
                [id],
              )
            ).rows[0].n,
            2,
          );
          assert.equal(
            (
              await migration.query(
                "SELECT count(*)::int AS n FROM auth.account_deactivation_event",
              )
            ).rows[0].n,
            0,
          );
          await cancelReservation(
            domain,
            actor,
            municipal.tenantId,
            firstReservation.result.id,
            randomUUID(),
            { expectedRevision: 1 },
            randomUUID(),
            3600,
          );
          assert.equal(
            (
              await first.request("/api/me/deactivation", {
                confirm: true,
                password,
              })
            ).statusCode,
            409,
          );
          await cancelReservation(
            domain,
            actor,
            otherMunicipal.tenantId,
            secondReservation.result.id,
            randomUUID(),
            { expectedRevision: 1 },
            randomUUID(),
            3600,
          );
        },
      );

      await t.test(
        "audit failure rolls back state and session revocation together",
        async () => {
          await migration.query(
            "CREATE FUNCTION auth.reject_deactivation_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic audit failure'; END $$; CREATE TRIGGER reject_deactivation_audit BEFORE INSERT ON auth.account_deactivation_event FOR EACH ROW EXECUTE FUNCTION auth.reject_deactivation_audit()",
          );
          try {
            assert.equal(
              (
                await first.request("/api/me/deactivation", {
                  confirm: true,
                  password,
                })
              ).statusCode,
              500,
            );
            assert.equal(
              (
                await auth.query(
                  "SELECT deactivated_at FROM auth.account_lifecycle WHERE account_id=$1",
                  [id],
                )
              ).rows[0].deactivated_at,
              null,
            );
            assert.equal(
              (
                await auth.query(
                  'SELECT count(*)::int AS n FROM auth.session WHERE "userId"=$1',
                  [id],
                )
              ).rows[0].n,
              2,
            );
          } finally {
            await migration.query(
              "DROP TRIGGER reject_deactivation_audit ON auth.account_deactivation_event; DROP FUNCTION auth.reject_deactivation_audit()",
            );
          }
        },
      );

      await t.test(
        "success removes sessions across replicas without deleting retained records",
        async () => {
          const before = (
            await migration.query(
              "SELECT row_to_json(r) AS data FROM domain.reservation r WHERE account_id=$1 ORDER BY tenant_id,id",
              [id],
            )
          ).rows;
          const events = (
            await migration.query(
              "SELECT row_to_json(e) AS data FROM domain.reservation_event e ORDER BY tenant_id,id",
            )
          ).rows;
          const result = await first.request("/api/me/deactivation", {
            confirm: true,
            password,
          });
          assert.equal(result.statusCode, 200, result.body);
          assert.equal(result.json().status, "DEACTIVATED");
          assert.equal(
            (
              await auth.query(
                'SELECT count(*)::int AS n FROM auth.session WHERE "userId"=$1',
                [id],
              )
            ).rows[0].n,
            0,
          );
          const recorded = (
            await migration.query(
              "SELECT * FROM auth.account_deactivation_event WHERE subject_id=$1",
              [id],
            )
          ).rows[0];
          assert.equal(recorded.revoked_sessions, 2);
          assert.equal(recorded.correlation_id, result.headers["x-request-id"]);
          assert.equal(
            recorded.occurred_at.toISOString(),
            result.json().deactivatedAt,
          );
          assert.deepEqual(
            (
              await migration.query(
                "SELECT row_to_json(r) AS data FROM domain.reservation r WHERE account_id=$1 ORDER BY tenant_id,id",
                [id],
              )
            ).rows,
            before,
          );
          assert.deepEqual(
            (
              await migration.query(
                "SELECT row_to_json(e) AS data FROM domain.reservation_event e ORDER BY tenant_id,id",
              )
            ).rows,
            events,
          );
          assert.equal(
            (
              await auth.query(
                'SELECT count(*)::int AS n FROM auth."user" WHERE id=$1',
                [id],
              )
            ).rows[0].n,
            1,
          );
          for (const [server, cookie] of [
            [app, firstCookie],
            [replica, secondCookie],
          ] as const) {
            assert.equal(
              (await server.inject({ url: "/api/me", headers: { cookie } }))
                .statusCode,
              401,
            );
            assert.equal(
              (
                await server.inject({
                  method: "PUT",
                  url: "/api/me/preferences",
                  headers: { cookie, origin: config.origin },
                  payload: { locale: "gl" },
                })
              ).statusCode,
              401,
            );
          }
          const login = await first.request("/api/auth/sign-in/email", {
            email,
            password,
          });
          assert.equal(login.statusCode, 403, login.body);
          assert.equal(login.json().error.code, "ACCOUNT_INACTIVE");
          assert.equal(
            (
              await first.request("/api/me/deactivation", {
                confirm: true,
                password,
              })
            ).statusCode,
            401,
          );
          await assert.rejects(saveAccountPreferences(domain, actor, "gl"), {
            code: "ACCOUNT_INACTIVE",
          });
          await assert.rejects(
            deactivateAccount(
              domain,
              actor,
              randomUUID(),
              proofDigest(actor.accountId),
            ),
            {
              code: "ACCOUNT_INACTIVE",
            },
          );
          await assert.rejects(
            auth.query("UPDATE auth.\"user\" SET name='Changed' WHERE id=$1", [
              id,
            ]),
            { code: "42501" },
          );
          await assert.rejects(
            auth.query(
              "UPDATE auth.account SET password='forbidden' WHERE \"userId\"=$1",
              [id],
            ),
            { code: "42501" },
          );
        },
      );

      await t.test(
        "runtime roles cannot directly alter lifecycle or audit",
        async () => {
          for (const pool of [domain, auth, worker]) {
            await assert.rejects(
              pool.query(
                "UPDATE auth.account_lifecycle SET deactivated_at=NULL",
              ),
              { code: "42501" },
            );
            await assert.rejects(
              pool.query("SELECT * FROM auth.account_deactivation_event"),
              { code: "42501" },
            );
          }
          await assert.rejects(
            domain.query(
              "SELECT * FROM domain.deactivate_current_account($1,$2)",
              [randomUUID(), proofDigest(actor.accountId)],
            ),
            { code: "42501" },
          );
        },
      );
      for (const contract of contracts) contract.assertValid();
    } finally {
      await app.close();
      await replica.close();
    }
  });
});

test("deactivation serializes against reservation commands and session creation", {
  timeout: 60000,
}, async (t) => {
  await withDatabase(async ({ auth, domain, migration, administration }) => {
    for (const id of [
      "reservation-first",
      "deactivation-first",
      "session-first",
      "session-after",
    ])
      await auth.query(
        'INSERT INTO auth."user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())',
        [id, `${id}@example.test`],
      );

    for (const id of [
      "reservation-first",
      "deactivation-first",
      "session-first",
      "session-after",
    ])
      await seedProof(migration, id);

    await t.test(
      "booking committing first prevents deactivation despite its earlier snapshot",
      async () => {
        const actor = account("reservation-first");
        const municipal = await fixture(migration, actor.accountId);
        const gate = await migration.connect();
        let creating: Promise<unknown> | undefined;
        let deactivating: Promise<unknown> | undefined;
        try {
          await migration.query(
            "CREATE FUNCTION domain.pause_reservation_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(64001); RETURN NEW; END $$; CREATE TRIGGER pause_reservation_fixture BEFORE INSERT ON domain.reservation FOR EACH ROW EXECUTE FUNCTION domain.pause_reservation_fixture()",
          );
          await gate.query("SELECT pg_advisory_lock(64001)");
          creating = createReservation(
            domain,
            actor,
            municipal.tenantId,
            randomUUID(),
            municipal.input,
            randomUUID(),
            3600,
          );
          await waitForBlockedQuery(
            administration,
            "INSERT INTO domain.reservation",
          );
          deactivating = assert.rejects(
            deactivateAccount(
              domain,
              actor,
              randomUUID(),
              proofDigest(actor.accountId),
            ),
            { code: "ACCOUNT_HAS_FUTURE_RESERVATIONS" },
          );
          await waitForBlockedQuery(
            administration,
            "domain.deactivate_current_account",
          );
          await gate.query("SELECT pg_advisory_unlock(64001)");
          await creating;
          await deactivating;
          assert.equal(
            (
              await auth.query(
                "SELECT deactivated_at FROM auth.account_lifecycle WHERE account_id=$1",
                [actor.accountId],
              )
            ).rows[0].deactivated_at,
            null,
          );
        } finally {
          await gate.query("SELECT pg_advisory_unlock(64001)");
          await Promise.allSettled(
            [creating, deactivating].filter((p) => p !== undefined),
          );
          gate.release();
          await migration.query(
            "DROP TRIGGER pause_reservation_fixture ON domain.reservation; DROP FUNCTION domain.pause_reservation_fixture()",
          );
        }
      },
    );

    await t.test(
      "deactivation committing first prevents a stale authenticated booking",
      async () => {
        const actor = account("deactivation-first");
        const municipal = await fixture(migration, actor.accountId);
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        let acquired: () => void = () => {};
        const locked = new Promise<void>((resolve) => {
          acquired = resolve;
        });
        const deactivating = transaction(
          domain,
          async (client) => {
            const result = await client.query(
              "SELECT * FROM domain.deactivate_current_account($1,$2)",
              [randomUUID(), proofDigest(actor.accountId)],
            );
            assert.equal(result.rows[0].outcome, "DEACTIVATED");
            acquired();
            await gate;
          },
          { accountId: actor.accountId, tenantId: null },
        );
        await locked;
        const creating = assert.rejects(
          createReservation(
            domain,
            actor,
            municipal.tenantId,
            randomUUID(),
            municipal.input,
            randomUUID(),
            3600,
          ),
          { code: "ACCOUNT_INACTIVE" },
        );
        try {
          await waitForBlockedQuery(
            administration,
            "domain.lock_active_account",
          );
        } finally {
          release();
        }
        await deactivating;
        await creating;
        assert.equal(
          (
            await migration.query(
              "SELECT count(*)::int AS n FROM domain.reservation WHERE account_id=$1",
              [actor.accountId],
            )
          ).rows[0].n,
          0,
        );
      },
    );

    await t.test(
      "a concurrent session committed before deactivation is also removed",
      async () => {
        const actor = account("session-first");
        const gate = await migration.connect();
        let creating: Promise<unknown> | undefined;
        let deactivating: Promise<unknown> | undefined;
        try {
          await migration.query(
            "CREATE FUNCTION auth.pause_session_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(64002); RETURN NEW; END $$; CREATE TRIGGER pause_session_fixture AFTER INSERT ON auth.session FOR EACH ROW EXECUTE FUNCTION auth.pause_session_fixture()",
          );
          await gate.query("SELECT pg_advisory_lock(64002)");
          creating = auth.query(
            'INSERT INTO auth.session(id,"expiresAt",token,"userId","updatedAt") VALUES($1,now()+interval \'1 day\',$1,$2,now())',
            [randomUUID(), actor.accountId],
          );
          await waitForBlockedQuery(administration, "INSERT INTO auth.session");
          deactivating = deactivateAccount(
            domain,
            actor,
            randomUUID(),
            proofDigest(actor.accountId),
          );
          await waitForBlockedQuery(
            administration,
            "domain.lock_active_account",
          );
          await gate.query("SELECT pg_advisory_unlock(64002)");
          await creating;
          await deactivating;
          assert.equal(
            (
              await auth.query(
                'SELECT count(*)::int AS n FROM auth.session WHERE "userId"=$1',
                [actor.accountId],
              )
            ).rows[0].n,
            0,
          );
        } finally {
          await gate.query("SELECT pg_advisory_unlock(64002)");
          await Promise.allSettled(
            [creating, deactivating].filter((p) => p !== undefined),
          );
          gate.release();
          await migration.query(
            "DROP TRIGGER pause_session_fixture ON auth.session; DROP FUNCTION auth.pause_session_fixture()",
          );
        }
      },
    );

    await t.test(
      "a session creation waiting for deactivation cannot restore access",
      async () => {
        const actor = account("session-after");
        const client = await domain.connect();
        try {
          await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
          await client.query("SELECT set_config('quenda.account_id',$1,true)", [
            actor.accountId,
          ]);
          await client.query(
            "SELECT * FROM domain.deactivate_current_account($1,$2)",
            [randomUUID(), proofDigest(actor.accountId)],
          );
          const creating = assert.rejects(
            auth.query(
              'INSERT INTO auth.session(id,"expiresAt",token,"userId","updatedAt") VALUES($1,now()+interval \'1 day\',$1,$2,now())',
              [randomUUID(), actor.accountId],
            ),
            { code: "42501" },
          );
          await waitForBlockedQuery(administration, "INSERT INTO auth.session");
          await client.query("COMMIT");
          await creating;
          assert.equal(
            (
              await auth.query(
                'SELECT count(*)::int AS n FROM auth.session WHERE "userId"=$1',
                [actor.accountId],
              )
            ).rows[0].n,
            0,
          );
        } finally {
          await client.query("ROLLBACK");
          client.release();
        }
      },
    );
  });
});

test("deactivation migration initializes existing accounts without revoking valid sessions", {
  timeout: 60000,
}, async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "quenda-before-deactivation-"),
  );
  try {
    await cp(path.resolve("db/migrations"), directory, { recursive: true });
    for (const filename of await readdir(directory))
      if (filename.endsWith(".sql") && filename >= "0064_")
        await rm(path.join(directory, filename));
    await withDatabase(async ({ auth, domain, migration }) => {
      await auth.query(
        'INSERT INTO auth."user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES(\'legacy-account\',\'Legacy\',\'legacy@example.test\',true,now(),now())',
      );
      await auth.query(
        "INSERT INTO auth.session(id,\"expiresAt\",token,\"userId\",\"updatedAt\") VALUES('legacy-session',now()+interval '1 day','legacy-token','legacy-account',now())",
      );
      const owner = new Client({
        connectionString: migration.options.connectionString,
      });
      await owner.connect();
      try {
        await migrate(owner, path.resolve("db/migrations"));
      } finally {
        await owner.end();
      }
      assert.deepEqual(
        (
          await auth.query(
            "SELECT account_id,deactivated_at,session_generation FROM auth.account_lifecycle",
          )
        ).rows,
        [
          {
            account_id: "legacy-account",
            deactivated_at: null,
            session_generation: "0",
          },
        ],
      );
      assert.equal(
        (await auth.query("SELECT count(*)::int AS n FROM auth.session"))
          .rows[0].n,
        1,
      );
      await seedProof(migration, "legacy-account");
      assert.equal(
        (
          await deactivateAccount(
            domain,
            account("legacy-account"),
            randomUUID(),
            proofDigest("legacy-account"),
          )
        ).status,
        "DEACTIVATED",
      );
      assert.equal(
        (await auth.query("SELECT count(*)::int AS n FROM auth.session"))
          .rows[0].n,
        0,
      );
    }, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("deactivation does not remove the last active platform or municipal responsibility", {
  timeout: 60000,
}, async () => {
  await withDatabase(async ({ auth, domain, migration }) => {
    for (const id of [
      "operator-a",
      "operator-b",
      "administrator-a",
      "administrator-b",
    ])
      await auth.query(
        'INSERT INTO auth."user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())',
        [id, `${id}@example.test`],
      );
    for (const id of [
      "operator-a",
      "operator-b",
      "administrator-a",
      "administrator-b",
    ]) {
      await migration.query(
        'UPDATE auth."user" SET "twoFactorEnabled"=true WHERE id=$1',
        [id],
      );
      await seedProof(migration, id);
    }
    await migration.query(
      "INSERT INTO domain.platform_operator(account_id) VALUES('operator-a')",
    );
    await assert.rejects(
      deactivateAccount(
        domain,
        account("operator-a"),
        randomUUID(),
        proofDigest("operator-a"),
      ),
      { code: "ACCOUNT_HANDOVER_REQUIRED" },
    );
    await migration.query(
      "INSERT INTO domain.platform_operator(account_id) VALUES('operator-b')",
    );
    const attempts = await Promise.allSettled([
      deactivateAccount(
        domain,
        account("operator-a"),
        randomUUID(),
        proofDigest("operator-a"),
      ),
      deactivateAccount(
        domain,
        account("operator-b"),
        randomUUID(),
        proofDigest("operator-b"),
      ),
    ]);
    assert.equal(
      attempts.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assert.equal(
      attempts.filter(
        (result) =>
          result.status === "rejected" &&
          result.reason.code === "ACCOUNT_HANDOVER_REQUIRED",
      ).length,
      1,
    );
    assert.equal(
      (
        await migration.query(
          "SELECT count(*)::int AS n FROM domain.platform_operator p JOIN auth.account_lifecycle l ON l.account_id=p.account_id WHERE p.revoked_at IS NULL AND l.deactivated_at IS NULL",
        )
      ).rows[0].n,
      1,
    );

    const tenant = randomUUID();
    await migration.query(
      "INSERT INTO domain.municipality(id,name,timezone) VALUES($1,'Responsibility fixture','Europe/Madrid')",
      [tenant],
    );
    for (const id of ["administrator-a", "administrator-b"]) {
      const invitation = randomUUID();
      await migration.query(
        "INSERT INTO domain.municipal_profile(tenant_id,account_id) VALUES($1,$2)",
        [tenant, id],
      );
      await migration.query(
        "INSERT INTO domain.administrator_invitation(tenant_id,id,account_id,invited_by,expires_at,accepted_at) VALUES($1,$2,$3,'operator-a',now()+interval '1 day',now())",
        [tenant, invitation, id],
      );
      await migration.query(
        "INSERT INTO domain.municipal_administrator(tenant_id,account_id,invitation_id,revoked_at) VALUES($1,$2,$3,CASE WHEN $2='administrator-b' THEN now() ELSE NULL END)",
        [tenant, id, invitation],
      );
    }
    // An existing but revoked administrator is not a valid replacement.
    await assert.rejects(
      deactivateAccount(
        domain,
        account("administrator-a"),
        randomUUID(),
        proofDigest("administrator-a"),
      ),
      { code: "ACCOUNT_HANDOVER_REQUIRED" },
    );
    await migration.query(
      "UPDATE domain.municipal_administrator SET revoked_at=NULL,granted_at=now()-interval '2 days',expires_at=now()-interval '1 day' WHERE account_id='administrator-b'",
    );
    // An unrevoked but expired administrator cannot take over responsibility.
    await assert.rejects(
      deactivateAccount(
        domain,
        account("administrator-a"),
        randomUUID(),
        proofDigest("administrator-a"),
      ),
      { code: "ACCOUNT_HANDOVER_REQUIRED" },
    );
    await migration.query(
      "UPDATE domain.municipal_administrator SET expires_at=now()+interval '1 day' WHERE account_id='administrator-b'",
    );
    await assert.rejects(
      deactivateAccount(
        domain,
        account("administrator-a"),
        randomUUID(),
        proofDigest("administrator-a"),
      ),
      { code: "ACCOUNT_HANDOVER_REQUIRED" },
    );
    await migration.query(
      "UPDATE domain.municipal_administrator SET expires_at=NULL WHERE account_id='administrator-b'",
    );
    assert.equal(
      (
        await deactivateAccount(
          domain,
          account("administrator-a"),
          randomUUID(),
          proofDigest("administrator-a"),
        )
      ).status,
      "DEACTIVATED",
    );
    // Historical grants on a deactivated account do not count as active custody.
    await assert.rejects(
      deactivateAccount(
        domain,
        account("administrator-b"),
        randomUUID(),
        proofDigest("administrator-b"),
      ),
      { code: "ACCOUNT_HANDOVER_REQUIRED" },
    );
    // Once its only grant has expired, this account has no active custody to
    // transfer; a historical role must not prevent its logical deactivation.
    await migration.query(
      "UPDATE domain.municipal_administrator SET expires_at=now()-interval '1 day' WHERE account_id='administrator-b'",
    );
    assert.equal(
      (
        await deactivateAccount(
          domain,
          account("administrator-b"),
          randomUUID(),
          proofDigest("administrator-b"),
        )
      ).status,
      "DEACTIVATED",
    );
  });
});
