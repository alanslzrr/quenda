import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { initializeOperator } from "../../scripts/lib/initialize-operator.ts";
import { buildApp } from "../../src/app.ts";
import { command } from "../../src/database/command.ts";
import { createAuthentication } from "../../src/modules/identity/auth.ts";
import {
  acceptManager,
  inviteManager,
} from "../../src/modules/identity/manager.ts";
import {
  acceptAdministratorInvitation,
  createMunicipality,
} from "../../src/modules/identity/municipality.ts";
import {
  acceptGlobalPrivacy,
  inviteGlobalPrivacy,
} from "../../src/modules/identity/privacy-permissions.ts";
import { withDatabase } from "../helpers/postgres.ts";
import { verifyProductResponses } from "../helpers/response-contract.ts";

const actor = (id: string) => ({
  accountId: id,
  email: `${id}@example.test`,
  sessionId: `session-${id}`,
  mfaVerifiedAt: new Date(),
});
const expiry = () => new Date(Date.now() + 86400000).toISOString();

test("retention policy HTTP requires explicit scope authorization and never defaults legal periods", {
  timeout: 60000,
}, async () => {
  await withDatabase(async ({ auth, domain, migration }) => {
    for (const id of [
      "operator",
      "admin-a",
      "admin-b",
      "privacy-a",
      "privacy-b",
      "reader",
      "erasure-target",
    ])
      await auth.query(
        'INSERT INTO auth."user"(id,name,email,"emailVerified","twoFactorEnabled","createdAt","updatedAt") VALUES($1,$1,$2,true,true,now(),now())',
        [id, `${id}@example.test`],
      );
    const owner = await migration.connect();
    try {
      await initializeOperator(owner, "operator");
    } finally {
      owner.release();
    }
    const municipality = async (admin: string, delegate: string) => {
      const item = await createMunicipality(domain, actor("operator"), {
        name: admin,
        timezone: "Europe/Madrid",
        administratorEmail: `${admin}@example.test`,
        invitationExpiresAt: expiry(),
      });
      await acceptAdministratorInvitation(
        domain,
        actor(admin),
        item.tenantId,
        item.invitationId,
      );
      const grant = await inviteManager(domain, actor(admin), item.tenantId, {
        email: `${delegate}@example.test`,
        expiresAt: expiry(),
        permissions: [
          { operation: "PRIVACY_READ", unitId: null },
          { operation: "PRIVACY_EXECUTE", unitId: null },
        ],
      });
      await acceptManager(
        domain,
        actor(delegate),
        item.tenantId,
        grant.invitationId,
      );
      return item.tenantId;
    };
    const a = await municipality("admin-a", "privacy-a"),
      b = await municipality("admin-b", "privacy-b");
    const read = await inviteManager(domain, actor("admin-a"), a, {
      email: "reader@example.test",
      expiresAt: expiry(),
      permissions: [{ operation: "PRIVACY_READ", unitId: null }],
    });
    await acceptManager(domain, actor("reader"), a, read.invitationId);
    const config = {
      origin: "https://quenda.test",
      secret: randomBytes(32).toString("hex"),
    };
    const authentication = createAuthentication(auth, config, {
      send: async () => {},
    });
    const app = await buildApp({
      database: { check: async () => {}, close: async () => {} },
      domain,
      logLevel: "silent",
      identity: {
        config,
        authentication: {
          ...authentication,
          authenticate: async (headers) => {
            const id = headers.get("x-test-account");
            if (!id) return null;
            return {
              ...actor(id),
              mfaVerifiedAt: headers.has("x-test-stale-mfa")
                ? new Date(Date.now() - 300001)
                : new Date(),
            };
          },
        },
      },
    });
    const contracts = verifyProductResponses(app);
    const send = (id: string, url: string, payload?: object, stale = false) =>
      app.inject({
        method: payload ? "POST" : "GET",
        url,
        headers: {
          origin: config.origin,
          "x-test-account": id,
          ...(stale ? { "x-test-stale-mfa": "true" } : {}),
        },
        ...(payload ? { payload } : {}),
      });
    const ok = (result: Awaited<ReturnType<typeof send>>, status = 200) => {
      assert.equal(result.statusCode, status, result.body);
      return result.json();
    };
    const policy = {
      category: "COMMUNICATIONS",
      retentionDays: 7,
      action: "ERASE",
      purpose: "Comunicación de reservas: plazo sintético de prueba",
      controllerReference: "Responsable sintético",
      approvalReference: "Aprobación sintética de prueba",
      reason: "Configuración de conservación de prueba",
    };
    const path = (tenant: string) =>
      `/api/municipalities/${tenant}/retention-policies`;
    try {
      assert.equal(
        (await app.inject({ method: "GET", url: path(a) })).statusCode,
        401,
      );
      assert.equal((await send("admin-a", path(a))).statusCode, 403);
      assert.equal((await send("operator", path(a))).statusCode, 403);
      assert.equal((await send("reader", path(a), policy)).statusCode, 403);
      assert.equal((await send("privacy-a", path(b), policy)).statusCode, 403);
      assert.equal(
        (await send("privacy-a", path(a), policy, true)).statusCode,
        403,
      );
      const { retentionDays: _period, ...missingPeriod } = policy;
      for (const invalid of [
        missingPeriod,
        { ...policy, retentionDays: 0 },
        { ...policy, approvalReference: "" },
        { ...policy, action: "BLOCK" },
        { ...policy, blockDays: 10 },
        { ...policy, tenantId: b },
      ])
        assert.equal(
          (await send("privacy-a", path(a), invalid)).statusCode,
          400,
        );
      const first = ok(await send("privacy-a", path(a), policy), 201);
      for (const invalid of [
        [],
        "scalar",
        { ...policy, retentionDays: 1.5 },
        { ...policy, retentionDays: 365001 },
        { ...policy, purpose: {} },
        { ...policy, action: "BLOCK", blockDays: 0 },
      ]) {
        const result = await command(
          domain,
          { accountId: "privacy-a", tenantId: a },
          (client) =>
            client.query(
              "SELECT domain.approve_retention_policy($1,$2,$3,$4) AS outcome",
              [randomUUID(), a, JSON.stringify(invalid), randomUUID()],
            ),
        );
        assert.equal(result.rows[0].outcome, "INVALID_INPUT");
      }
      const second = ok(
        await send("privacy-b", path(b), { ...policy, retentionDays: 9 }),
        201,
      );
      const response = await send("reader", path(a));
      assert.equal(response.headers["cache-control"], "no-store");
      const listed = ok(response);
      assert.equal(listed.hasMore, false);
      assert.equal(listed.policies.length, 1);
      assert.equal(listed.policies[0].policyId, first.policyId);
      assert.equal(listed.policies[0].scopeTenantId, a);
      assert.equal(listed.policies[0].retentionDays, 7);
      assert.equal(listed.policies[0].blockDays, null);
      assert.equal(
        ok(await send("privacy-b", path(b))).policies[0].policyId,
        second.policyId,
      );
      assert.equal(
        ok(await send("privacy-b", path(b))).policies[0].retentionDays,
        9,
      );
      const revised = ok(
        await send("privacy-a", path(a), {
          ...policy,
          retentionDays: 8,
          action: "BLOCK",
          blockDays: 5,
          approvalReference: "Nueva aprobación sintética",
        }),
        201,
      );
      const versions = ok(await send("privacy-a", path(a))).policies;
      assert.equal(versions.length, 2);
      assert.equal(
        versions.find(
          (p: { policyId: string }) => p.policyId === first.policyId,
        ).retentionDays,
        7,
      );
      assert.ok(
        versions.find(
          (p: { policyId: string }) => p.policyId === first.policyId,
        ).supersededAt,
      );
      assert.equal(
        versions.find(
          (p: { policyId: string }) => p.policyId === revised.policyId,
        ).blockDays,
        5,
      );
      assert.equal(
        (
          await send("reader", `${path(a)}/${revised.policyId}/revoke`, {
            reason: "Retirada",
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await send("privacy-b", `${path(b)}/${revised.policyId}/revoke`, {
            reason: "Otro ámbito",
          })
        ).statusCode,
        404,
      );
      ok(
        await send("privacy-a", `${path(a)}/${revised.policyId}/revoke`, {
          reason: "Revisión por el responsable",
        }),
      );
      const after = ok(await send("privacy-a", path(a))).policies;
      assert.ok(
        after.find((p: { policyId: string }) => p.policyId === revised.policyId)
          .revokedAt,
      );
      assert.ok(
        after.find((p: { policyId: string }) => p.policyId === first.policyId)
          .supersededAt,
      );
      const holds = path(a).replace("retention-policies", "retention-holds");
      const status = path(a).replace("retention-policies", "retention-status");
      const holdInput = {
        category: "COMMUNICATIONS",
        subjectId: "privacy-a",
        authorizationReference: "Excepción sintética autorizada",
        reason: "Conservación requerida durante una revisión",
      };
      assert.equal((await send("reader", holds, holdInput)).statusCode, 403);
      assert.equal((await send("privacy-b", status)).statusCode, 403);
      for (const invalid of [
        { ...holdInput, targetKey: "also-a-target" },
        { ...holdInput, subjectId: "" },
        { ...holdInput, authorizationReference: "" },
        { ...holdInput, category: "IDENTITY" },
      ])
        assert.equal((await send("privacy-a", holds, invalid)).statusCode, 400);
      for (const missing of [
        { ...holdInput, subjectId: "not-an-account" },
        { ...holdInput, subjectId: "admin-b" },
        {
          category: "RESERVATIONS",
          targetKey: "not-a-uuid",
          authorizationReference: holdInput.authorizationReference,
          reason: holdInput.reason,
        },
      ])
        assert.equal((await send("privacy-a", holds, missing)).statusCode, 404);
      const hold = ok(await send("privacy-a", holds, holdInput), 201);
      const state = ok(await send("reader", status));
      assert.equal(state.hasMoreHolds, false);
      assert.equal(state.hasMoreConflicts, false);
      assert.equal(state.holds.length, 1);
      assert.equal(state.holds[0].holdId, hold.holdId);
      assert.equal(state.holds[0].subjectId, "privacy-a");
      assert.equal(state.holds[0].targetKey, null);
      const releaseInput = {
        authorizationReference: "Autorización sintética de finalización",
        reason: "Finaliza la excepción",
      };
      assert.equal(
        (await send("reader", `${holds}/${hold.holdId}/release`, releaseInput))
          .statusCode,
        403,
      );
      assert.equal(
        (
          await send(
            "privacy-b",
            `${path(b).replace("retention-policies", "retention-holds")}/${hold.holdId}/release`,
            releaseInput,
          )
        ).statusCode,
        404,
      );
      ok(
        await send(
          "privacy-a",
          `${holds}/${hold.holdId}/release`,
          releaseInput,
        ),
      );
      assert.equal(ok(await send("reader", status)).holds.length, 0);
      const actions = path(a).replace("retention-policies", "privacy-actions");
      const action = {
        category: "AUTHORITY",
        targetKey: "privacy-a",
        action: "ERASE",
        authorizationReference: "Actuación individual sintética",
        reason: "Prueba de protección de autoridad activa",
      };
      assert.equal((await send("reader", actions, action)).statusCode, 403);
      assert.equal((await send("admin-a", actions, action)).statusCode, 403);
      for (const invalid of [
        { ...action, targetKey: "" },
        { ...action, authorizationReference: "" },
        { ...action, action: "BLOCK" },
        { ...action, blockDays: 1 },
      ])
        assert.equal(
          (await send("privacy-a", actions, invalid)).statusCode,
          400,
        );
      const conflict = ok(await send("privacy-a", actions, action));
      assert.equal(conflict.status, "CONFLICT");
      assert.equal(conflict.reason, "ACTIVE_AUTHORITY");
      assert.equal(
        (
          await migration.query(
            "SELECT 1 FROM domain.retention_event WHERE id=$1 AND operation='RIGHTS_ACTION_SKIPPED'",
            [conflict.eventId],
          )
        ).rowCount,
        1,
      );
      await migration.query(
        "INSERT INTO domain.municipal_profile(tenant_id,account_id) VALUES($1,'erasure-target'),($2,'erasure-target')",
        [a, b],
      );
      const protectedProfile = ok(
        await send("privacy-a", holds, {
          ...holdInput,
          category: "MUNICIPAL_PROFILE",
          subjectId: "erasure-target",
        }),
        201,
      );
      const prevented = ok(
        await send("privacy-a", actions, {
          ...action,
          category: "MUNICIPAL_PROFILE",
          targetKey: "erasure-target",
        }),
      );
      assert.equal(prevented.status, "CONFLICT");
      assert.equal(prevented.reason, "LEGAL_HOLD");
      ok(
        await send(
          "privacy-a",
          `${holds}/${protectedProfile.holdId}/release`,
          releaseInput,
        ),
      );
      const erased = ok(
        await send("privacy-a", actions, {
          ...action,
          category: "MUNICIPAL_PROFILE",
          targetKey: "erasure-target",
        }),
      );
      assert.equal(erased.status, "APPLIED");
      assert.deepEqual(Object.keys(erased).sort(), ["eventId", "status"]);
      assert.equal(
        (
          await migration.query(
            "SELECT tenant_id FROM domain.municipal_profile WHERE account_id='erasure-target'",
          )
        ).rows[0]?.tenant_id,
        b,
      );
      assert.equal(
        (
          await migration.query('SELECT 1 FROM auth."user" WHERE id=$1', [
            "erasure-target",
          ])
        ).rowCount,
        1,
      );
      const absent = ok(
        await send("privacy-a", actions, {
          ...action,
          category: "MUNICIPAL_PROFILE",
          targetKey: "erasure-target",
        }),
      );
      assert.equal(absent.status, "ABSENT");
      const blocked = ok(
        await send(
          "privacy-b",
          path(b).replace("retention-policies", "privacy-actions"),
          {
            ...action,
            category: "MUNICIPAL_PROFILE",
            targetKey: "erasure-target",
            action: "BLOCK",
            blockDays: 5,
          },
        ),
      );
      assert.equal(blocked.status, "APPLIED");
      const archiveHold = ok(
        await send(
          "privacy-b",
          path(b).replace("retention-policies", "retention-holds"),
          {
            category: "MUNICIPAL_PROFILE",
            targetKey: "erasure-target",
            authorizationReference: holdInput.authorizationReference,
            reason: "Excepción sobre contenido ya bloqueado",
          },
        ),
        201,
      );
      assert.ok(archiveHold.holdId);
      const globalPath = "/api/platform/retention-policies";
      assert.equal((await send("operator", globalPath)).statusCode, 403);
      const global = await inviteGlobalPrivacy(domain, actor("operator"), {
        accountId: "operator",
        permissions: ["PRIVACY_READ", "PRIVACY_EXECUTE"],
        expiresAt: expiry(),
        reason: "Autorización global explícita de prueba",
      });
      await acceptGlobalPrivacy(domain, actor("operator"), global.invitationId);
      const globalPolicy = ok(
        await send("operator", globalPath, {
          ...policy,
          category: "AUTHENTICATION",
        }),
        201,
      );
      assert.equal(
        ok(await send("operator", globalPath)).policies[0].policyId,
        globalPolicy.policyId,
      );
      assert.equal(
        ok(await send("operator", globalPath)).policies[0].scopeTenantId,
        null,
      );
      assert.equal((await send("operator", path(a))).statusCode, 403);
      ok(
        await send(
          "operator",
          `${globalPath}/${globalPolicy.policyId}/revoke`,
          { reason: "Retirada global" },
        ),
      );
      contracts.assertValid();
    } finally {
      await app.close();
    }
  });
});
