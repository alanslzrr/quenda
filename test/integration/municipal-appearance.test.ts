import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import Fastify from "fastify";
import { initializeOperator } from "../../scripts/lib/initialize-operator.ts";
import { registerErrors } from "../../src/http/errors.ts";
import {
  publicAppearance,
  saveAppearance,
} from "../../src/modules/identity/appearance.ts";
import { registerAppearanceRoutes } from "../../src/modules/identity/appearance-routes.ts";
import type { Authentication } from "../../src/modules/identity/auth.ts";
import {
  acceptAdministratorInvitation,
  createMunicipality,
} from "../../src/modules/identity/municipality.ts";
import { withDatabase } from "../helpers/postgres.ts";

test("municipal appearance is constrained, isolated, versioned and audited atomically", {
  timeout: 60000,
}, async () => {
  await withDatabase(async ({ domain, auth, migration, worker }) => {
    const actor = (id: string) => ({
      accountId: id,
      email: `${id}@example.test`,
      sessionId: id,
      mfaVerifiedAt: new Date(),
    });
    for (const id of ["operator", "admin", "outsider"])
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
    const create = async () => {
      const item = await createMunicipality(domain, actor("operator"), {
        name: "Municipio",
        timezone: "Europe/Madrid",
        administratorId: "admin",
        invitationExpiresAt: new Date(Date.now() + 3600000).toISOString(),
      });
      await acceptAdministratorInvitation(
        domain,
        actor("admin"),
        item.tenantId,
        item.invitationId,
      );
      return item.tenantId;
    };
    const tenantId = await create();
    const other = await create();
    const defaults = {
      version: 1,
      lightPalette: "neutral",
      darkPalette: "neutral",
      defaultTheme: "light",
    };
    assert.deepEqual(await publicAppearance(domain, tenantId), defaults);
    const input = {
      expectedVersion: 1,
      lightPalette: "blue",
      darkPalette: "green",
      defaultTheme: "dark",
    } as const;
    for (const account of [
      actor("operator"),
      actor("outsider"),
      { ...actor("admin"), mfaVerifiedAt: null },
      { ...actor("admin"), mfaVerifiedAt: new Date(Date.now() - 300001) },
    ])
      await assert.rejects(
        saveAppearance(domain, account, tenantId, input, randomUUID()),
      );
    const competing = await Promise.allSettled([
      saveAppearance(domain, actor("admin"), tenantId, input, randomUUID()),
      saveAppearance(
        domain,
        actor("admin"),
        tenantId,
        { ...input, lightPalette: "green" },
        randomUUID(),
      ),
    ]);
    assert.equal(competing.filter((x) => x.status === "fulfilled").length, 1);
    assert.equal(
      competing.filter(
        (x) => x.status === "rejected" && x.reason.code === "CONFLICT",
      ).length,
      1,
    );
    assert.deepEqual(await publicAppearance(domain, other), defaults);
    const current = await publicAppearance(domain, tenantId);
    assert.equal(current.version, 2);
    assert.equal(
      (await migration.query("SELECT * FROM domain.municipal_appearance_event"))
        .rows.length,
      1,
    );
    for (const pool of [domain, auth, worker])
      await assert.rejects(
        pool.query("SELECT * FROM domain.municipal_appearance_event"),
        { code: "42501" },
      );
    await assert.rejects(
      domain.query(
        "UPDATE domain.municipality SET light_palette='blue' WHERE id=$1",
        [tenantId],
      ),
      { code: "42501" },
    );
    await migration.query(
      "CREATE FUNCTION domain.reject_appearance_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic audit failure'; END $$; CREATE TRIGGER reject_appearance_audit BEFORE INSERT ON domain.municipal_appearance_event FOR EACH ROW EXECUTE FUNCTION domain.reject_appearance_audit()",
    );
    await assert.rejects(
      saveAppearance(
        domain,
        actor("admin"),
        tenantId,
        { ...input, expectedVersion: 2 },
        randomUUID(),
      ),
    );
    assert.deepEqual(await publicAppearance(domain, tenantId), current);
    await migration.query(
      "DROP TRIGGER reject_appearance_audit ON domain.municipal_appearance_event; DROP FUNCTION domain.reject_appearance_audit()",
    );
    const app = Fastify({
      genReqId: () => randomUUID(),
      ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
    });
    registerErrors(app);
    await registerAppearanceRoutes(
      app,
      domain,
      { authenticate: async () => actor("admin") } as unknown as Authentication,
      { origin: "https://quenda.test", secret: "appearance-test-secret" },
    );
    try {
      assert.equal(
        (await app.inject(`/api/public/municipalities/${tenantId}/appearance`))
          .statusCode,
        200,
      );
      const request = (payload: object, origin = "https://quenda.test") =>
        app.inject({
          method: "PUT",
          url: `/api/municipalities/${tenantId}/appearance`,
          headers: { origin },
          payload,
        });
      assert.equal(
        (await request({ ...input, expectedVersion: 2, lightPalette: "#000" }))
          .statusCode,
        400,
      );
      assert.equal(
        (await request({ ...input, expectedVersion: 2, css: "body{}" }))
          .statusCode,
        400,
      );
      assert.equal(
        (
          await request(
            { ...input, expectedVersion: 2 },
            "https://untrusted.test",
          )
        ).statusCode,
        403,
      );
      const reset = await request({
        expectedVersion: 2,
        lightPalette: "neutral",
        darkPalette: "neutral",
        defaultTheme: "light",
      });
      assert.equal(reset.statusCode, 200);
      assert.deepEqual(reset.json(), { ...defaults, version: 3 });
      assert.equal(
        (await request({ ...input, expectedVersion: 2 })).statusCode,
        409,
      );
    } finally {
      await app.close();
    }
  });
});
