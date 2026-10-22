import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import Fastify from "fastify";
import { initializeOperator } from "../../scripts/lib/initialize-operator.ts";
import { registerErrors } from "../../src/http/errors.ts";
import type { Authentication } from "../../src/modules/identity/auth.ts";
import {
  acceptManager,
  inviteManager,
} from "../../src/modules/identity/manager.ts";
import {
  acceptAdministratorInvitation,
  createMunicipality,
} from "../../src/modules/identity/municipality.ts";
import {
  accountNavigation,
  publicMunicipalities,
} from "../../src/modules/identity/navigation.ts";
import { registerNavigationRoutes } from "../../src/modules/identity/navigation-routes.ts";
import { withDatabase } from "../helpers/postgres.ts";

test("public discovery and own navigation preserve authority boundaries and pagination", {
  timeout: 60000,
}, async () => {
  await withDatabase(async ({ domain, auth, migration, worker }) => {
    const actor = (id: string) => ({
      accountId: id,
      email: `${id}@example.test`,
      sessionId: id,
      mfaVerifiedAt: new Date(),
    });
    for (const id of ["operator", "admin", "manager", "citizen"])
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
    const municipalities = [];
    for (let i = 0; i < 22; i++) {
      const item = await createMunicipality(domain, actor("operator"), {
        name: `Municipio ${i}`,
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
      municipalities.push(item.tenantId);
    }
    const tenantId = municipalities[0];
    assert.ok(tenantId);
    const publicPage = await publicMunicipalities(domain);
    assert.equal(publicPage.items.length, 20);
    assert.ok(publicPage.nextCursor);
    assert.deepEqual(Object.keys(publicPage.items[0] ?? {}).sort(), [
      "id",
      "name",
      "timeZone",
    ]);
    const rest = await publicMunicipalities(domain, publicPage.nextCursor);
    assert.equal(rest.items.length, 2);
    assert.equal(rest.nextCursor, null);
    assert.equal(
      new Set([...publicPage.items, ...rest.items].map((x) => x.id)).size,
      22,
    );
    await assert.rejects(publicMunicipalities(domain, null, randomUUID()), {
      code: "NOT_FOUND",
    });
    assert.equal(
      (await publicMunicipalities(domain, null, tenantId)).items[0]?.id,
      tenantId,
    );
    assert.deepEqual(await accountNavigation(domain, actor("citizen")), {
      municipalities: { items: [], nextCursor: null },
      platform: { operator: false, permissions: [] },
    });
    const platform = await accountNavigation(domain, actor("operator"));
    assert.equal(platform.platform.operator, true);
    assert.equal(platform.municipalities.items.length, 0);
    const adminPage = await accountNavigation(domain, actor("admin"));
    assert.equal(adminPage.municipalities.items.length, 20);
    assert.equal(adminPage.platform.operator, false);
    assert.ok(
      adminPage.municipalities.items.every(
        (x) => x.administrator && x.permissions.length === 0,
      ),
    );
    const invite = await inviteManager(domain, actor("admin"), tenantId, {
      accountId: "manager",
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      permissions: [{ operation: "PRIVACY_READ", unitId: null }],
    });
    assert.equal(
      (await accountNavigation(domain, actor("manager"))).municipalities.items
        .length,
      0,
    );
    await acceptManager(
      domain,
      actor("manager"),
      tenantId,
      invite.invitationId,
    );
    const manager = await accountNavigation(domain, actor("manager"));
    assert.equal(manager.municipalities.items.length, 1);
    assert.deepEqual(manager.municipalities.items[0]?.permissions, [
      { operation: "PRIVACY_READ", unitId: null },
    ]);
    assert.equal(manager.municipalities.items[0]?.administrator, false);
    await migration.query(
      "UPDATE domain.manager_grant SET revoked_at=now() WHERE tenant_id=$1",
      [tenantId],
    );
    assert.equal(
      (await accountNavigation(domain, actor("manager"))).municipalities.items
        .length,
      0,
    );
    for (const pool of [auth, worker])
      await assert.rejects(
        pool.query("SELECT * FROM domain.public_municipalities(NULL,NULL)"),
        { code: "42501" },
      );
    assert.equal(
      (await domain.query("SELECT * FROM domain.municipality")).rows.length,
      0,
    );
    assert.equal(
      (await domain.query("SELECT * FROM domain.own_municipal_contexts(NULL)"))
        .rows.length,
      0,
    );
    const app = Fastify({
      ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
    });
    registerErrors(app);
    await registerNavigationRoutes(
      app,
      domain,
      {
        authenticate: async (headers) =>
          headers.get("cookie") === "valid" ? actor("admin") : null,
      } as Authentication,
      { origin: "https://quenda.test", secret: "navigation-test-secret" },
    );
    try {
      assert.equal(
        (await app.inject("/api/public/municipalities")).statusCode,
        200,
      );
      assert.equal(
        (await app.inject("/api/public/municipalities?after=bad")).statusCode,
        400,
      );
      assert.equal((await app.inject("/api/me/navigation")).statusCode, 401);
      const response = await app.inject({
        url: "/api/me/navigation",
        headers: { cookie: "valid" },
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers["cache-control"], "no-store");
      assert.equal(response.json().municipalities.items.length, 20);
      assert.equal(
        (await app.inject("/api/me/navigation?accountId=citizen")).statusCode,
        400,
      );
    } finally {
      await app.close();
    }
  });
});
