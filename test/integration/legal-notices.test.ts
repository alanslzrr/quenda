import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import Fastify from "fastify";
import { initializeOperator } from "../../scripts/lib/initialize-operator.ts";
import { registerErrors } from "../../src/http/errors.ts";
import type { Authentication } from "../../src/modules/identity/auth.ts";
import { registerLegalNoticeRoutes } from "../../src/modules/identity/legal-notice-routes.ts";
import {
  noticeFields,
  publicNotice,
  saveNotice,
} from "../../src/modules/identity/legal-notices.ts";
import {
  acceptAdministratorInvitation,
  createMunicipality,
} from "../../src/modules/identity/municipality.ts";
import { withDatabase } from "../helpers/postgres.ts";

test("legal texts are versioned, append-only, scoped to their owner and published only through permission", {
  timeout: 90000,
}, async () => {
  await withDatabase(async ({ auth, domain, migration }) => {
    const actor = (id: string, recent = true) => ({
      accountId: id,
      email: `${id}@example.test`,
      sessionId: id,
      mfaVerifiedAt: recent ? new Date() : new Date(Date.now() - 3600000),
    });
    for (const id of ["operator", "admin", "other-admin", "outsider"])
      await auth.query(
        'INSERT INTO auth."user"(id,name,email,"emailVerified","createdAt","updatedAt","twoFactorEnabled") VALUES($1,$1,$2,true,now(),now(),true)',
        [id, `${id}@example.test`],
      );
    const owner = await migration.connect();
    try {
      await initializeOperator(owner, "operator");
    } finally {
      owner.release();
    }
    const create = async (administrator: string) => {
      const item = await createMunicipality(domain, actor("operator"), {
        name: "Municipio",
        timezone: "Europe/Madrid",
        administratorEmail: `${administrator}@example.test`,
        invitationExpiresAt: new Date(Date.now() + 3600000).toISOString(),
      });
      await acceptAdministratorInvitation(
        domain,
        actor(administrator),
        item.tenantId,
        item.invitationId,
      );
      return item.tenantId;
    };
    const tenantId = await create("admin");
    const otherTenant = await create("other-admin");

    await test("nothing published reads as version 0 and an unknown municipality is not found", async () => {
      const empty = await publicNotice(domain, tenantId, "privacy");
      assert.deepEqual(
        {
          kind: empty.kind,
          version: empty.version,
          body: empty.body,
          at: empty.publishedAt,
        },
        { kind: "privacy", version: 0, body: {}, at: null },
      );
      assert.equal((await publicNotice(domain, null, "legal")).version, 0);
      await assert.rejects(publicNotice(domain, randomUUID(), "privacy"), {
        code: "NOT_FOUND",
      });
    });

    await test("an administrator publishes versions in order and the latest is what the public reads", async () => {
      const first = await saveNotice(
        domain,
        actor("admin"),
        tenantId,
        "privacy",
        {
          expectedVersion: 0,
          body: {
            gl: {
              controller: "  Concello de Proba  ",
              purposes: "Xestionar reservas",
              dpo: "   ",
            },
            es: { controller: "Ayuntamiento de Prueba" },
          },
        },
      );
      assert.deepEqual(first, { kind: "privacy", version: 1 });
      const second = await saveNotice(
        domain,
        actor("admin"),
        tenantId,
        "privacy",
        {
          expectedVersion: 1,
          body: {
            es: {
              controller: "Ayuntamiento de Prueba",
              rights: "Escrito al registro",
            },
          },
        },
      );
      assert.equal(second.version, 2);
      const current = await publicNotice(domain, tenantId, "privacy");
      assert.equal(current.version, 2);
      assert.deepEqual(current.body, {
        es: {
          controller: "Ayuntamiento de Prueba",
          rights: "Escrito al registro",
        },
      });
      assert.ok(current.publishedAt);
      // The first version is preserved, trimmed and without blank fields.
      const old = (
        await migration.query(
          "SELECT body FROM domain.legal_notice WHERE tenant_id=$1 AND kind='privacy' AND version=1",
          [tenantId],
        )
      ).rows[0];
      assert.deepEqual(old.body, {
        gl: { controller: "Concello de Proba", purposes: "Xestionar reservas" },
        es: { controller: "Ayuntamiento de Prueba" },
      });
    });

    await test("a stale version conflicts and nothing is written", async () => {
      await assert.rejects(
        saveNotice(domain, actor("admin"), tenantId, "privacy", {
          expectedVersion: 1,
          body: { es: { controller: "Otro" } },
        }),
        { code: "STALE_VERSION" },
      );
      await assert.rejects(
        saveNotice(domain, actor("admin"), tenantId, "legal", {
          expectedVersion: 3,
          body: { es: { entity: "X" } },
        }),
        { code: "STALE_VERSION" },
      );
      assert.equal(
        (
          await migration.query(
            "SELECT count(*)::int AS n FROM domain.legal_notice WHERE tenant_id=$1",
            [tenantId],
          )
        ).rows[0].n,
        2,
      );
    });

    await test("concurrent publications from the same version produce a single new version", async () => {
      const outcomes = await Promise.allSettled(
        [1, 2, 3, 4].map((n) =>
          saveNotice(domain, actor("admin"), tenantId, "legal", {
            expectedVersion: 0,
            body: { es: { entity: `Entidad ${n}` } },
          }),
        ),
      );
      assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1);
      assert.equal(
        outcomes.filter(
          (o) =>
            o.status === "rejected" &&
            (o.reason as { code?: string }).code === "STALE_VERSION",
        ).length,
        3,
      );
    });

    await test("rows can neither be changed nor removed, not even by the maintenance role", async () => {
      await assert.rejects(
        migration.query(
          "UPDATE domain.legal_notice SET body='{}'::jsonb WHERE tenant_id=$1",
          [tenantId],
        ),
        { code: "42501" },
      );
      await assert.rejects(
        migration.query("DELETE FROM domain.legal_notice WHERE tenant_id=$1", [
          tenantId,
        ]),
        { code: "42501" },
      );
      await assert.rejects(domain.query("SELECT * FROM domain.legal_notice"), {
        code: "42501",
      });
    });

    await test("only the owner of the scope may publish, with recent verification", async () => {
      const body = { expectedVersion: 0, body: { es: { address: "Calle 1" } } };
      await assert.rejects(
        saveNotice(domain, actor("outsider"), tenantId, "legal", {
          ...body,
          expectedVersion: 1,
        }),
        { code: "FORBIDDEN" },
      );
      await assert.rejects(
        saveNotice(domain, actor("other-admin"), tenantId, "legal", {
          ...body,
          expectedVersion: 1,
        }),
        { code: "FORBIDDEN" },
      );
      await assert.rejects(
        saveNotice(domain, actor("admin", false), tenantId, "legal", {
          ...body,
          expectedVersion: 1,
        }),
        { code: "REAUTHENTICATION_REQUIRED" },
      );
      await assert.rejects(
        saveNotice(domain, actor("admin"), null, "legal", body),
        { code: "FORBIDDEN" },
      );
      await assert.rejects(
        saveNotice(domain, actor("operator"), tenantId, "legal", {
          ...body,
          expectedVersion: 1,
        }),
        { code: "FORBIDDEN" },
      );
      // Another municipality is unaffected by all of the above.
      assert.equal(
        (await publicNotice(domain, otherTenant, "legal")).version,
        0,
      );
    });

    await test("the operator publishes the instance texts and municipalities do not see them as their own", async () => {
      const saved = await saveNotice(
        domain,
        actor("operator"),
        null,
        "accessibility",
        {
          expectedVersion: 0,
          body: {
            status: "partial",
            preparedOn: "2026-10-01",
            reviewedOn: "2026-11-01",
            es: {
              nonAccessible: "Gráficos de indicadores",
              feedback: "accesibilidad@example.test",
            },
          },
        },
      );
      assert.equal(saved.version, 1);
      const instance = await publicNotice(domain, null, "accessibility");
      assert.equal(instance.body.status, "partial");
      assert.equal(
        (await publicNotice(domain, tenantId, "accessibility")).version,
        0,
      );
      await assert.rejects(
        saveNotice(domain, actor("operator", false), null, "legal", {
          expectedVersion: 0,
          body: { es: { entity: "X" } },
        }),
        { code: "REAUTHENTICATION_REQUIRED" },
      );
    });

    await test("content is validated: unknown fields, wrong kind fields, dates and size", async () => {
      const attempt = (
        kind: "privacy" | "legal" | "accessibility",
        body: object,
      ) =>
        saveNotice(domain, actor("admin"), tenantId, kind, {
          expectedVersion: 99,
          body,
        } as never);
      for (const [kind, body] of [
        ["privacy", { es: { entity: "campo de otro tipo" } }],
        ["privacy", { status: "full", es: { controller: "X" } }],
        ["legal", { preparedOn: "2026-01-01", es: { entity: "X" } }],
        ["accessibility", { status: "perfect", es: { feedback: "X" } }],
        ["accessibility", { preparedOn: "2026-02-30", es: { feedback: "X" } }],
        [
          "accessibility",
          {
            preparedOn: "2026-05-01",
            reviewedOn: "2026-04-01",
            es: { feedback: "X" },
          },
        ],
        ["privacy", { es: { controller: "x".repeat(4001) } }],
        [
          "privacy",
          Object.fromEntries(
            ["gl", "es"].map((language) => [
              language,
              Object.fromEntries(
                noticeFields.privacy.map((field) => [field, "ñ".repeat(4000)]),
              ),
            ]),
          ),
        ],
        ["privacy", { es: {} }],
        ["privacy", {}],
      ] as const)
        await assert.rejects(
          attempt(kind, body),
          { code: "INVALID_INPUT" },
          JSON.stringify(body),
        );
    });

    await test("HTTP: public reads are open, writes need the session, origin and a strict body", async () => {
      const app = Fastify({
        genReqId: () => randomUUID(),
        ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
      });
      registerErrors(app);
      let current = actor("admin");
      await registerLegalNoticeRoutes(
        app,
        domain,
        { authenticate: async () => current } as unknown as Authentication,
        { origin: "https://quenda.test", secret: "legal-test-secret" },
      );
      try {
        const publicRead = await app.inject(
          `/api/public/municipalities/${tenantId}/notices/privacy`,
        );
        assert.equal(publicRead.statusCode, 200, publicRead.body);
        assert.equal(publicRead.json().version, 2);
        assert.equal(
          (await app.inject("/api/public/notices/privacy")).json().version,
          0,
        );
        assert.equal(
          (await app.inject("/api/public/notices/cookies")).statusCode,
          400,
        );
        assert.equal(
          (
            await app.inject(
              `/api/public/municipalities/${randomUUID()}/notices/privacy`,
            )
          ).statusCode,
          404,
        );
        const put = (
          payload: object,
          origin = "https://quenda.test",
          url = `/api/municipalities/${tenantId}/notices/legal`,
        ) => app.inject({ method: "PUT", url, headers: { origin }, payload });
        const ok = await put({
          expectedVersion: 1,
          body: { gl: { address: "Rúa 1" } },
        });
        assert.equal(ok.statusCode, 200, ok.body);
        assert.deepEqual(ok.json(), { kind: "legal", version: 2 });
        assert.equal(
          (
            await put({
              expectedVersion: 1,
              body: { gl: { address: "Rúa 2" } },
            })
          ).statusCode,
          409,
        );
        for (const bad of [
          { expectedVersion: 2 },
          { expectedVersion: 2, body: {} },
          { expectedVersion: 2, body: { gl: { address: "x" } }, extra: true },
          { expectedVersion: 2, body: { fr: { address: "x" } } },
          { expectedVersion: 2, body: { gl: { script: "<b>x</b>" } } },
        ])
          assert.equal((await put(bad)).statusCode, 400, JSON.stringify(bad));
        assert.equal(
          (
            await put(
              { expectedVersion: 2, body: { gl: { address: "x" } } },
              "https://untrusted.test",
            )
          ).statusCode,
          403,
        );
        current = actor("outsider");
        assert.equal(
          (await put({ expectedVersion: 2, body: { gl: { address: "x" } } }))
            .statusCode,
          403,
        );
        const platform = await app.inject({
          method: "PUT",
          url: "/api/platform/notices/privacy",
          headers: { origin: "https://quenda.test" },
          payload: {
            expectedVersion: 0,
            body: { es: { controller: "Operador" } },
          },
        });
        assert.equal(platform.statusCode, 403);
      } finally {
        await app.close();
      }
    });
  });
});
