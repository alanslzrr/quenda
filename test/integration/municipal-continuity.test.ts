import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { initializeOperator } from "../../scripts/lib/initialize-operator.ts";
import { buildApp } from "../../src/app.ts";
import { transaction } from "../../src/database/transaction.ts";
import { listMunicipalAdministrators } from "../../src/modules/identity/administrator-query.ts";
import {
  inviteAdministrator,
  listOwnAdministratorInvitations,
  revokeAdministrator,
} from "../../src/modules/identity/invitations.ts";
import {
  acceptManager,
  inviteManager,
  listOwnManagerInvitations,
  requirePermission,
} from "../../src/modules/identity/manager.ts";
import {
  makeAdministratorIndefinite,
  recoverMunicipalAdministrator,
  revokeMunicipalAccessForSecurity,
} from "../../src/modules/identity/municipal-continuity.ts";
import {
  acceptAdministratorInvitation,
  createMunicipality,
  replaceInitialAdministratorInvitation,
} from "../../src/modules/identity/municipality.ts";
import { withDatabase } from "../helpers/postgres.ts";
import { verifyProductResponses } from "../helpers/response-contract.ts";

const actor = (id: string) => ({
  accountId: id,
  email: `${id}@example.test`,
  sessionId: `session-${id}`,
  mfaVerifiedAt: new Date(),
});
const expiry = () => new Date(Date.now() + 3_600_000).toISOString();

test("municipal continuity protects lasting responsibility and separates security recovery from global access", {
  timeout: 60_000,
}, async (t) => {
  await withDatabase(async ({ domain, auth, migration }) => {
    for (const id of [
      "operator",
      "a",
      "b",
      "c",
      "manager",
      "pending",
      "replacement",
      "no-mfa",
    ]) {
      await auth.query(
        'INSERT INTO auth."user"(id,name,email,"emailVerified","createdAt","updatedAt","twoFactorEnabled") VALUES($1,$1,$2,true,now(),now(),$3)',
        [id, `${id}@example.test`, id !== "no-mfa"],
      );
    }
    const connection = await migration.connect();
    try {
      await initializeOperator(connection, "operator");
    } finally {
      connection.release();
    }
    async function municipality(admin = "a") {
      const municipality = await createMunicipality(domain, actor("operator"), {
        name: "Synthetic municipality",
        timezone: "Europe/Madrid",
        administratorId: admin,
        invitationExpiresAt: expiry(),
      });
      await acceptAdministratorInvitation(
        domain,
        actor(admin),
        municipality.tenantId,
        municipality.invitationId,
      );
      return municipality.tenantId;
    }
    async function addAdministrator(
      tenantId: string,
      accountId: string,
      roleExpiresAt: string | null = null,
    ) {
      const invitation = await inviteAdministrator(
        domain,
        actor("a"),
        tenantId,
        { accountId, expiresAt: expiry(), roleExpiresAt },
      );
      await acceptAdministratorInvitation(
        domain,
        actor(accountId),
        tenantId,
        invitation.invitationId,
      );
      return invitation.invitationId;
    }
    await t.test(
      "last indefinite administrator cannot resign even when a temporary administrator remains",
      async () => {
        const tenant = await municipality();
        await addAdministrator(tenant, "b", expiry());
        await assert.rejects(
          revokeAdministrator(domain, actor("a"), tenant, "a", "Handover"),
          { code: "ACCOUNT_HANDOVER_REQUIRED" },
        );
        const before = await migration.query(
          "SELECT invitation_id FROM domain.municipal_administrator WHERE tenant_id=$1 AND account_id='b'",
          [tenant],
        );
        await makeAdministratorIndefinite(
          domain,
          actor("a"),
          tenant,
          "b",
          "Permanent successor",
        );
        await makeAdministratorIndefinite(
          domain,
          actor("a"),
          tenant,
          "b",
          "Repeated request",
        );
        const after = await migration.query(
          "SELECT invitation_id,expires_at FROM domain.municipal_administrator WHERE tenant_id=$1 AND account_id='b'",
          [tenant],
        );
        assert.equal(after.rows[0].invitation_id, before.rows[0].invitation_id);
        assert.equal(after.rows[0].expires_at, null);
        assert.equal(
          (
            await migration.query(
              "SELECT * FROM domain.identity_event WHERE tenant_id=$1 AND operation='MAKE_ADMINISTRATOR_INDEFINITE'",
              [tenant],
            )
          ).rowCount,
          1,
        );
        await revokeAdministrator(
          domain,
          actor("a"),
          tenant,
          "a",
          "Completed handover",
        );
        assert.deepEqual(
          (
            await listMunicipalAdministrators(domain, actor("b"), tenant)
          ).items.map((row) => [row.accountId, row.active]),
          [
            ["a", false],
            ["b", true],
          ],
        );
        await assert.rejects(
          revokeAdministrator(
            domain,
            actor("b"),
            tenant,
            "b",
            "Last responsible",
          ),
          { code: "ACCOUNT_HANDOVER_REQUIRED" },
        );
        await assert.rejects(
          makeAdministratorIndefinite(
            domain,
            actor("b"),
            tenant,
            "a",
            "Revoked role",
          ),
          { code: "NOT_FOUND" },
        );
      },
    );
    await t.test(
      "a temporary administrator cannot extend its own authority",
      async () => {
        const tenant = await municipality();
        const limit = new Date(Date.now() + 3600000).toISOString();
        await addAdministrator(tenant, "b", limit);
        for (const subject of ["b", "a"])
          await assert.rejects(
            makeAdministratorIndefinite(
              domain,
              actor("b"),
              tenant,
              subject,
              "Self extension",
            ),
            { code: "FORBIDDEN" },
          );
        const invite = (roleExpiresAt: string | null) =>
          inviteAdministrator(domain, actor("b"), tenant, {
            accountId: "c",
            expiresAt: expiry(),
            roleExpiresAt,
          });
        await assert.rejects(invite(null), { code: "FORBIDDEN" });
        await assert.rejects(
          invite(new Date(Date.parse(limit) + 1000).toISOString()),
          { code: "FORBIDDEN" },
        );
        await invite(limit);
        assert.equal(
          (
            await migration.query(
              "SELECT expires_at IS NOT NULL AS temporary FROM domain.municipal_administrator WHERE tenant_id=$1 AND account_id='b'",
              [tenant],
            )
          ).rows[0].temporary,
          true,
        );
      },
    );
    await t.test(
      "concurrent ordinary resignations leave one indefinite responsible account",
      async () => {
        const tenant = await municipality();
        await addAdministrator(tenant, "b");
        const results = await Promise.allSettled(
          ["a", "b"].map((id) =>
            revokeAdministrator(domain, actor(id), tenant, id, "Resignation"),
          ),
        );
        assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
        assert.equal(
          results.filter(
            (r) =>
              r.status === "rejected" &&
              r.reason.code === "ACCOUNT_HANDOVER_REQUIRED",
          ).length,
          1,
        );
        assert.equal(
          (
            await migration.query(
              "SELECT * FROM domain.municipal_administrator WHERE tenant_id=$1 AND revoked_at IS NULL AND expires_at IS NULL",
              [tenant],
            )
          ).rowCount,
          1,
        );
      },
    );
    await t.test(
      "emergency local revocation clears all target privileges only in that municipality",
      async () => {
        const tenant = await municipality();
        const other = await municipality();
        const manager = await inviteManager(domain, actor("a"), tenant, {
          accountId: "a",
          expiresAt: expiry(),
          permissions: [{ operation: "RESERVATION_MANAGE", unitId: null }],
        });
        await acceptManager(domain, actor("a"), tenant, manager.invitationId);
        const acceptedManager = await inviteManager(
          domain,
          actor("a"),
          tenant,
          {
            accountId: "manager",
            expiresAt: expiry(),
            permissions: [{ operation: "RESERVATION_READ", unitId: null }],
          },
        );
        await acceptManager(
          domain,
          actor("manager"),
          tenant,
          acceptedManager.invitationId,
        );
        const pending = await inviteManager(domain, actor("a"), tenant, {
          accountId: "pending",
          expiresAt: expiry(),
          permissions: [{ operation: "RESERVATION_READ", unitId: null }],
        });
        const pendingAdmin = await inviteAdministrator(
          domain,
          actor("a"),
          tenant,
          { accountId: "pending", expiresAt: expiry() },
        );
        const lifecycleBefore = (
          await migration.query(
            "SELECT * FROM auth.account_lifecycle WHERE account_id='a'",
          )
        ).rows;
        await revokeMunicipalAccessForSecurity(
          domain,
          actor("a"),
          tenant,
          "a",
          "Compromised municipal permissions",
        );
        assert.deepEqual(
          (
            await migration.query(
              "SELECT * FROM auth.account_lifecycle WHERE account_id='a'",
            )
          ).rows,
          lifecycleBefore,
        );
        await assert.rejects(
          transaction(
            domain,
            (client) =>
              requirePermission(client, actor("a"), "RESERVATION_MANAGE"),
            { accountId: "a", tenantId: tenant },
          ),
          { code: "FORBIDDEN" },
        );
        await transaction(
          domain,
          (client) =>
            requirePermission(client, actor("a"), "RESERVATION_MANAGE"),
          { accountId: "a", tenantId: other },
        );
        await transaction(
          domain,
          (client) =>
            requirePermission(client, actor("manager"), "RESERVATION_READ"),
          { accountId: "manager", tenantId: tenant },
        );
        await assert.rejects(
          acceptManager(domain, actor("pending"), tenant, pending.invitationId),
          { code: "NOT_FOUND" },
        );
        await assert.rejects(
          acceptAdministratorInvitation(
            domain,
            actor("pending"),
            tenant,
            pendingAdmin.invitationId,
          ),
          { code: "NOT_FOUND" },
        );
        assert.equal(
          (
            await migration.query(
              "SELECT * FROM domain.identity_event WHERE tenant_id=$1 AND operation='SECURITY_REVOKE_ADMINISTRATOR' AND reason='Compromised municipal permissions'",
              [tenant],
            )
          ).rowCount,
          1,
        );
        await assert.rejects(
          replaceInitialAdministratorInvitation(
            domain,
            actor("operator"),
            tenant,
            {
              accountId: "replacement",
              expiresAt: expiry(),
              reason: "No bootstrap reopening",
            },
          ),
          { code: "CONFLICT" },
        );
        await assert.rejects(
          recoverMunicipalAdministrator(domain, actor("b"), tenant, {
            accountId: "replacement",
            expiresAt: expiry(),
            reason: "Recovery",
            verificationReference: "Authority-123",
          }),
          { code: "FORBIDDEN" },
        );
        await assert.rejects(
          recoverMunicipalAdministrator(domain, actor("operator"), other, {
            accountId: "replacement",
            expiresAt: expiry(),
            reason: "Not orphaned",
            verificationReference: "Authority-123",
          }),
          { code: "CONFLICT" },
        );
        const recovery = await recoverMunicipalAdministrator(
          domain,
          actor("operator"),
          tenant,
          {
            accountId: "replacement",
            expiresAt: expiry(),
            reason: "Verified municipal handover",
            verificationReference: "Authority-123",
          },
        );
        assert.equal(
          (
            await migration.query(
              "SELECT * FROM domain.municipal_administrator WHERE tenant_id=$1 AND revoked_at IS NULL",
              [tenant],
            )
          ).rowCount,
          0,
        );
        await assert.rejects(
          transaction(
            domain,
            (client) =>
              requirePermission(client, actor("operator"), "RESERVATION_READ"),
            { accountId: "operator", tenantId: tenant },
          ),
          { code: "FORBIDDEN" },
        );
        await acceptAdministratorInvitation(
          domain,
          actor("replacement"),
          tenant,
          recovery.invitationId,
        );
        const restored = (
          await listMunicipalAdministrators(
            domain,
            actor("replacement"),
            tenant,
          )
        ).items;
        assert.equal(
          restored.find((row) => row.accountId === "a")?.active,
          false,
        );
        assert.equal(
          restored.find((row) => row.accountId === "replacement")?.active,
          true,
        );
        assert.equal(
          restored.find((row) => row.accountId === "replacement")?.expiresAt,
          null,
        );
        assert.equal(
          (
            await migration.query(
              "SELECT verification_reference FROM domain.identity_event WHERE tenant_id=$1 AND operation='RECOVER_ADMINISTRATOR'",
              [tenant],
            )
          ).rows[0].verification_reference,
          "Authority-123",
        );
      },
    );
    await t.test(
      "municipal continuity HTTP validates authority, origin and published contracts",
      async () => {
        const tenant = await municipality();
        await addAdministrator(tenant, "b", expiry());
        let activeAccount: string | null = "a";
        const unavailable = async (): Promise<never> => {
          throw new Error("Unused authentication operation");
        };
        const config = {
          origin: "https://quenda.test",
          secret: "unused-test-secret",
        };
        const app = await buildApp({
          database: { check: async () => {}, close: async () => {} },
          domain,
          logLevel: "silent",
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
              authenticate: async () =>
                activeAccount ? actor(activeAccount) : null,
            },
          },
        });
        const contract = verifyProductResponses(app);
        const headers = { origin: config.origin };
        try {
          const promote = `/api/municipalities/${tenant}/administrators/b/make-indefinite`;
          assert.equal(
            (
              await app.inject({
                method: "POST",
                url: promote,
                payload: { reason: "Handover" },
              })
            ).statusCode,
            403,
          );
          activeAccount = null;
          assert.equal(
            (
              await app.inject({
                method: "POST",
                url: promote,
                headers,
                payload: { reason: "Handover" },
              })
            ).statusCode,
            401,
          );
          activeAccount = "a";
          const promoted = await app.inject({
            method: "POST",
            url: promote,
            headers,
            payload: { reason: "Handover" },
          });
          assert.equal(promoted.statusCode, 200, promoted.body);
          assert.deepEqual(promoted.json(), {
            tenantId: tenant,
            accountId: "b",
          });
          for (const target of ["b", "a"]) {
            const revoked = await app.inject({
              method: "POST",
              url: `/api/municipalities/${tenant}/accounts/${target}/revoke-access-for-security`,
              headers,
              payload: { reason: "Verified security incident" },
            });
            assert.equal(revoked.statusCode, 200, revoked.body);
          }
          activeAccount = "operator";
          const recovered = await app.inject({
            method: "POST",
            url: `/api/municipalities/${tenant}/administrator-recovery-invitations`,
            headers,
            payload: {
              accountId: "replacement",
              expiresAt: expiry(),
              reason: "Verified handover",
              verificationReference: "Recovery-HTTP-123",
            },
          });
          assert.equal(recovered.statusCode, 201, recovered.body);
          activeAccount = "replacement";
          const accepted = await app.inject({
            method: "POST",
            url: `/api/municipalities/${tenant}/administrator-invitations/${recovered.json().invitationId}/accept`,
            headers,
            payload: {},
          });
          assert.equal(accepted.statusCode, 200, accepted.body);
          contract.assertValid();
          assert.equal(contract.successes.size, 4);
        } finally {
          await app.close();
        }
      },
    );
    await t.test(
      "inactive issuers cannot authorize pending invitations or appear active",
      async () => {
        const tenant = await municipality();
        await addAdministrator(tenant, "b");
        const admin = await inviteAdministrator(domain, actor("a"), tenant, {
          accountId: "c",
          expiresAt: expiry(),
        });
        const manager = await inviteManager(domain, actor("a"), tenant, {
          accountId: "pending",
          expiresAt: expiry(),
          permissions: [{ operation: "RESERVATION_READ", unitId: null }],
        });
        // A legacy row whose grants were not cleaned up is still ineffective.
        await migration.query(
          "UPDATE auth.account_lifecycle SET deactivated_at=now() WHERE account_id='a'",
        );
        try {
          assert.equal(
            (
              await listMunicipalAdministrators(domain, actor("b"), tenant)
            ).items.find((row) => row.accountId === "a")?.active,
            false,
          );
          assert.equal(
            (
              await listOwnAdministratorInvitations(domain, actor("c"))
            ).items.find((row) => row.invitationId === admin.invitationId)
              ?.status,
            "INVALIDATED",
          );
          assert.equal(
            (
              await listOwnManagerInvitations(domain, actor("pending"))
            ).items.find((row) => row.invitationId === manager.invitationId)
              ?.status,
            "INVALIDATED",
          );
          await assert.rejects(
            acceptAdministratorInvitation(
              domain,
              actor("c"),
              tenant,
              admin.invitationId,
            ),
            { code: "NOT_FOUND" },
          );
          await assert.rejects(
            acceptManager(
              domain,
              actor("pending"),
              tenant,
              manager.invitationId,
            ),
            { code: "NOT_FOUND" },
          );
        } finally {
          await migration.query(
            "UPDATE auth.account_lifecycle SET deactivated_at=NULL WHERE account_id='a'",
          );
        }
      },
    );
    await t.test(
      "recovery acceptance requires actual MFA and cannot be forged through runtime SQL",
      async () => {
        const tenant = await municipality();
        await revokeMunicipalAccessForSecurity(
          domain,
          actor("a"),
          tenant,
          "a",
          "Emergency containment",
        );
        const recovery = await recoverMunicipalAdministrator(
          domain,
          actor("operator"),
          tenant,
          {
            accountId: "no-mfa",
            expiresAt: expiry(),
            reason: "Authority verified; MFA still required",
            verificationReference: "Municipality-ref-456",
          },
        );
        await assert.rejects(
          acceptAdministratorInvitation(
            domain,
            actor("no-mfa"),
            tenant,
            recovery.invitationId,
          ),
          { code: "NOT_FOUND" },
        );
        await assert.rejects(
          transaction(
            domain,
            (client) =>
              client.query(
                "INSERT INTO domain.administrator_invitation(tenant_id,id,account_id,invited_by,expires_at,grant_source) VALUES($1,$2,'c','operator',now()+interval '1 hour','RECOVERY')",
                [tenant, randomUUID()],
              ),
            { accountId: "operator", tenantId: tenant },
          ),
          { code: "42501" },
        );
        await assert.rejects(
          domain.query(
            "SELECT domain.revoke_administrator('a','Out-of-command mutation')",
          ),
          { code: "42501" },
        );
        for (const sql of [
          "UPDATE domain.municipal_administrator SET expires_at=NULL",
          "UPDATE domain.municipal_administrator SET revoked_at=NULL",
          "UPDATE domain.identity_event SET reason='forged'",
          "DELETE FROM domain.identity_event",
        ])
          await assert.rejects(domain.query(sql), { code: "42501" });
        await assert.rejects(
          makeAdministratorIndefinite(
            domain,
            actor("b"),
            tenant,
            "a",
            "Cross-scope",
          ),
          { code: "FORBIDDEN" },
        );
        await assert.rejects(
          recoverMunicipalAdministrator(domain, actor("operator"), tenant, {
            accountId: "c",
            expiresAt: expiry(),
            reason: "Recovery",
            verificationReference: "   ",
          }),
          { code: "INVALID_INPUT" },
        );
      },
    );
  });
});
