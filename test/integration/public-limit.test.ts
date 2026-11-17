import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { buildApp } from "../../src/app.ts";
import {
  consumePublicAttempt,
  publicSubjectHash,
} from "../../src/modules/catalog/public-limit.ts";
import { withDatabase } from "../helpers/postgres.ts";

test("public limits are shared, IP-private, atomic and clean up bounded expired counters", {
  timeout: 60000,
}, async (t) => {
  await withDatabase(async ({ domain, migration }) => {
    const config = {
      origin: "https://quenda.test",
      secret: "synthetic-secret-for-rate-limit-tests",
    };
    const hash = publicSubjectHash(config.secret, "192.0.2.1");
    assert.match(hash, /^[a-f0-9]{64}$/);
    assert.notEqual(hash, publicSubjectHash("different-secret", "192.0.2.1"));
    await t.test(
      "concurrent attempts produce exactly sixty admissions",
      async () => {
        const decisions = await Promise.all(
          Array.from({ length: 64 }, () => consumePublicAttempt(domain, hash)),
        );
        assert.equal(decisions.filter((row) => row.allowed).length, 60);
        assert.equal(decisions.filter((row) => !row.allowed).length, 4);
        assert.ok(
          decisions.every((row) => row.retryAfter >= 1 && row.retryAfter <= 60),
        );
        assert.equal(
          (
            await migration.query(
              "SELECT attempts FROM domain.public_rate_limit WHERE subject_hash=$1",
              [hash],
            )
          ).rows[0].attempts,
          61,
        );
        await migration.query(
          "UPDATE domain.public_rate_limit SET window_started_at=now()-interval '61 seconds' WHERE subject_hash=$1",
          [hash],
        );
        assert.equal((await consumePublicAttempt(domain, hash)).allowed, true);
        for (const sql of [
          "SELECT * FROM domain.public_rate_limit",
          "UPDATE domain.public_rate_limit SET attempts=1",
          "DELETE FROM domain.public_rate_limit",
        ])
          await assert.rejects(domain.query(sql), { code: "42501" });
      },
    );
    const unavailable = async (): Promise<never> => {
      throw new Error("Public reads must not call authentication");
    };
    const make = () =>
      buildApp({
        domain,
        logLevel: "silent",
        database: { check: async () => {}, close: async () => {} },
        identity: {
          config,
          authentication: {
            handler: unavailable,
            schema: unavailable,
            verifyDeactivation: unavailable,
            requestReactivation: unavailable,
            confirmReactivation: unavailable,
            requestEmailChange: unavailable,
            approveEmailChange: unavailable,
            confirmEmailChange: unavailable,
            authenticate: unavailable,
          },
        },
      });
    const apps = await Promise.all([make(), make()]);
    try {
      await t.test(
        "replicas share all public routes and ignore spoofed proxy headers",
        async () => {
          const tenant = randomUUID();
          for (let i = 0; i < 61; i++) {
            const app = apps[i % 2];
            assert.ok(app);
            const response = await app.inject({
              url: `/api/public/municipalities/${tenant}/facilities`,
              remoteAddress: "192.0.2.44",
              headers: {
                "x-forwarded-for": `198.51.100.${i}`,
                "x-real-ip": `198.51.100.${i}`,
              },
            });
            assert.equal(
              response.statusCode,
              i < 60 ? 200 : 429,
              response.body,
            );
            if (i === 60) {
              assert.equal(response.json().error.code, "RATE_LIMITED");
              assert.ok(Number(response.headers["retry-after"]) >= 1);
            }
          }
          const app = apps[0];
          assert.ok(app);
          const denied = await app.inject({
            url: `/api/public/municipalities/${tenant}/units/${randomUUID()}/availability?date=invalid&durationMinutes=60`,
            remoteAddress: "192.0.2.44",
          });
          assert.equal(denied.statusCode, 429, denied.body);
          const separate = await app.inject({
            url: `/api/public/municipalities/${tenant}/facilities`,
            remoteAddress: "192.0.2.45",
          });
          assert.equal(separate.statusCode, 200);
          const persisted = (
            await migration.query("SELECT * FROM domain.public_rate_limit")
          ).rows;
          assert.doesNotMatch(
            JSON.stringify(persisted),
            /192\.0\.2\.|198\.51\.100\./,
          );
          assert.equal(
            (
              await migration.query(
                "SELECT count(*)::int AS n FROM domain.municipal_profile",
              )
            ).rows[0].n,
            0,
          );
        },
      );
      await t.test(
        "CSP reports have their own shared allowance, separate from catalog reads",
        async () => {
          const report = JSON.stringify([
            {
              type: "csp-violation",
              body: {
                documentURL: `${config.origin}/perfil`,
                effectiveDirective: "img-src",
                blockedURL: "https://images.example.test/a.png",
                disposition: "enforce",
                statusCode: 200,
              },
            },
          ]);
          for (let i = 0; i < 61; i++) {
            const app = apps[i % 2];
            assert.ok(app);
            const response = await app.inject({
              method: "POST",
              url: "/api/csp-reports",
              remoteAddress: "192.0.2.46",
              headers: { "content-type": "application/reports+json" },
              payload: report,
            });
            assert.equal(
              response.statusCode,
              i < 60 ? 204 : 429,
              response.body,
            );
          }
          const app = apps[0];
          assert.ok(app);
          const catalog = await app.inject({
            url: `/api/public/municipalities/${randomUUID()}/facilities`,
            remoteAddress: "192.0.2.46",
          });
          assert.equal(catalog.statusCode, 200, catalog.body);
          assert.doesNotMatch(
            JSON.stringify(
              (await migration.query("SELECT * FROM domain.public_rate_limit"))
                .rows,
            ),
            /192\.0\.2\.46/,
          );
        },
      );
      await t.test(
        "cleanup is bounded per request and eventually removes expired hashes",
        async () => {
          await migration.query(
            "INSERT INTO domain.public_rate_limit SELECT md5(i::text)||md5(i::text),now()-interval '20 minutes',1 FROM generate_series(1,250) i",
          );
          const stale = async () =>
            Number(
              (
                await migration.query(
                  "SELECT count(*) FROM domain.public_rate_limit WHERE window_started_at<now()-interval '10 minutes'",
                )
              ).rows[0].count,
            );
          for (const count of [150, 50, 0]) {
            await consumePublicAttempt(domain, hash);
            assert.equal(await stale(), count);
          }
        },
      );
    } finally {
      await Promise.all(apps.map((app) => app.close()));
    }
  });
});
