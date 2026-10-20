import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { initializeOperator } from "../../scripts/lib/initialize-operator.ts";
import { command } from "../../src/database/command.ts";
import {
  acceptManager,
  inviteManager,
  revokeManager,
} from "../../src/modules/identity/manager.ts";
import {
  acceptAdministratorInvitation,
  createMunicipality,
} from "../../src/modules/identity/municipality.ts";
import {
  acceptOperatorInvitation,
  inviteOperator,
  revokeOperator,
} from "../../src/modules/identity/operator-lifecycle.ts";
import {
  acceptGlobalPrivacy,
  inviteGlobalPrivacy,
  listGlobalPrivacyInvitations,
  type PrivacyOperation,
  requirePrivacyPermission,
  revokeGlobalPrivacy,
} from "../../src/modules/identity/privacy-permissions.ts";
import { withDatabase } from "../helpers/postgres.ts";

const actor = (accountId: string) => ({
  accountId,
  email: `${accountId}@example.test`,
  sessionId: `session-${accountId}`,
  mfaVerifiedAt: new Date(),
});
const expiresAt = () => new Date(Date.now() + 86400000).toISOString();

test("privacy permissions are explicit, scoped, accepted and permanently withdrawn", {
  timeout: 60000,
}, async (t) => {
  await withDatabase(async ({ auth, domain, migration }) => {
    for (const id of [
      "operator",
      "next-operator",
      "admin-a",
      "admin-b",
      "reader",
      "global",
      "pending",
      "bare",
      "no-mfa",
    ])
      await auth.query(
        'INSERT INTO auth."user"(id,name,email,"emailVerified","twoFactorEnabled","createdAt","updatedAt") VALUES($1,$1,$2,true,$3,now(),now())',
        [id, `${id}@example.test`, id !== "no-mfa"],
      );
    const owner = await migration.connect();
    try {
      await initializeOperator(owner, "operator");
    } finally {
      owner.release();
    }
    const municipality = async (admin: string) => {
      const item = await createMunicipality(domain, actor("operator"), {
        name: admin,
        timezone: "Europe/Madrid",
        administratorId: admin,
        invitationExpiresAt: expiresAt(),
      });
      await acceptAdministratorInvitation(
        domain,
        actor(admin),
        item.tenantId,
        item.invitationId,
      );
      return item.tenantId;
    };
    const a = await municipality("admin-a"),
      b = await municipality("admin-b");
    const allowed = (
      id: string,
      tenant: string | null,
      operation: PrivacyOperation = "PRIVACY_READ",
    ) =>
      command(domain, { accountId: id, tenantId: tenant }, async (client) => {
        await requirePrivacyPermission(client, actor(id), operation, tenant);
      });
    const inviteGlobal = (id: string) =>
      inviteGlobalPrivacy(domain, actor("operator"), {
        accountId: id,
        permissions: ["PRIVACY_READ"],
        expiresAt: expiresAt(),
        reason: "Delegación aprobada sobre identidad global",
      });

    await t.test(
      "administrator and operator privileges never imply privacy privileges",
      async () => {
        await assert.rejects(allowed("operator", null), { code: "FORBIDDEN" });
        await assert.rejects(allowed("operator", a), { code: "FORBIDDEN" });
        await assert.rejects(allowed("admin-a", a), { code: "FORBIDDEN" });
        const old = await inviteManager(domain, actor("admin-a"), a, {
          accountId: "reader",
          expiresAt: expiresAt(),
          permissions: [{ operation: "DATA_EXPORT", unitId: null }],
        });
        await acceptManager(domain, actor("reader"), a, old.invitationId);
        await assert.rejects(allowed("reader", a), { code: "FORBIDDEN" });
        await assert.rejects(
          inviteManager(domain, actor("admin-a"), a, {
            accountId: "reader",
            expiresAt: expiresAt(),
            permissions: [{ operation: "PRIVACY_READ", unitId: randomUUID() }],
          }),
          { code: "INVALID_INPUT" },
        );
      },
    );
    let municipalGrant = "";
    await t.test(
      "municipal acceptance grants only named operations in its exact scope",
      async () => {
        const item = await inviteManager(domain, actor("admin-a"), a, {
          accountId: "reader",
          expiresAt: expiresAt(),
          permissions: [{ operation: "PRIVACY_READ", unitId: null }],
        });
        municipalGrant = item.invitationId;
        await assert.rejects(allowed("reader", a), { code: "FORBIDDEN" });
        await acceptManager(domain, actor("reader"), a, item.invitationId);
        await allowed("reader", a);
        await assert.rejects(allowed("reader", a, "PRIVACY_EXECUTE"), {
          code: "FORBIDDEN",
        });
        await assert.rejects(allowed("reader", b), { code: "FORBIDDEN" });
        await assert.rejects(allowed("reader", null), { code: "FORBIDDEN" });
        const cross = await command(
          domain,
          { accountId: "reader", tenantId: a },
          (client) =>
            client.query(
              "SELECT domain.lock_privacy_permission('PRIVACY_READ',$1) AS allowed",
              [b],
            ),
        );
        assert.equal(cross.rows[0].allowed, false);
        const self = await inviteManager(domain, actor("admin-a"), a, {
          accountId: "admin-a",
          expiresAt: expiresAt(),
          permissions: [{ operation: "PRIVACY_EXECUTE", unitId: null }],
        });
        await acceptManager(domain, actor("admin-a"), a, self.invitationId);
        await allowed("admin-a", a, "PRIVACY_EXECUTE");
        await assert.rejects(allowed("admin-a", a), { code: "FORBIDDEN" });
        await assert.rejects(
          command(domain, { accountId: "reader", tenantId: a }, (client) =>
            requirePrivacyPermission(
              client,
              {
                ...actor("reader"),
                mfaVerifiedAt: new Date(Date.now() - 300001),
              },
              "PRIVACY_READ",
              a,
            ),
          ),
          { code: "REAUTHENTICATION_REQUIRED" },
        );
      },
    );
    await t.test(
      "revocation waits for an authorized operation and blocks the next one",
      async () => {
        let unlock: () => void = () => {};
        let locked: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
          unlock = resolve;
        });
        const hasLock = new Promise<void>((resolve) => {
          locked = resolve;
        });
        const operation = command(
          domain,
          { accountId: "reader", tenantId: a },
          async (client) => {
            await requirePrivacyPermission(
              client,
              actor("reader"),
              "PRIVACY_READ",
              a,
            );
            locked();
            await gate;
          },
        );
        await hasLock;
        const revoked = revokeManager(
          domain,
          actor("admin-a"),
          a,
          municipalGrant,
          "Retirada de la autorización",
        );
        let completed = false;
        const withdrawal = revoked.then(() => {
          completed = true;
        });
        try {
          await setTimeout(40);
          assert.equal(completed, false);
        } finally {
          unlock();
        }
        await Promise.all([operation, withdrawal]);
        await assert.rejects(allowed("reader", a), { code: "FORBIDDEN" });
      },
    );
    let globalGrant = "";
    await t.test(
      "only operators invite for global identity; grants require recipient MFA and acceptance",
      async () => {
        for (const sql of [
          "SELECT * FROM domain.global_privacy_invitation",
          "SELECT * FROM domain.global_privacy_permission_event",
          "UPDATE domain.global_privacy_invitation SET revoked_at=NULL",
        ])
          await assert.rejects(domain.query(sql), { code: "42501" });
        await assert.rejects(
          inviteGlobalPrivacy(domain, actor("admin-a"), {
            accountId: "global",
            permissions: ["PRIVACY_READ"],
            expiresAt: expiresAt(),
            reason: "Municipal authority is insufficient",
          }),
          { code: "FORBIDDEN" },
        );
        await assert.rejects(
          listGlobalPrivacyInvitations(domain, actor("bare"), false),
          { code: "FORBIDDEN" },
        );
        assert.equal(
          (await listGlobalPrivacyInvitations(domain, actor("bare"), true))
            .items.length,
          0,
        );
        const noMfa = await inviteGlobal("no-mfa");
        await assert.rejects(
          acceptGlobalPrivacy(domain, actor("no-mfa"), noMfa.invitationId),
          { code: "FORBIDDEN" },
        );
        const item = await inviteGlobal("global");
        globalGrant = item.invitationId;
        await assert.rejects(allowed("global", null), { code: "FORBIDDEN" });
        await assert.rejects(
          acceptGlobalPrivacy(domain, actor("bare"), item.invitationId),
          { code: "NOT_FOUND" },
        );
        await acceptGlobalPrivacy(domain, actor("global"), item.invitationId);
        await acceptGlobalPrivacy(domain, actor("global"), item.invitationId);
        await allowed("global", null);
        await assert.rejects(allowed("global", a), { code: "FORBIDDEN" });
        await assert.rejects(allowed("global", null, "PRIVACY_EXECUTE"), {
          code: "FORBIDDEN",
        });
        assert.equal(
          (
            await migration.query(
              "SELECT 1 FROM domain.global_privacy_permission_event WHERE invitation_id=$1 AND operation='ACCEPT'",
              [globalGrant],
            )
          ).rowCount,
          1,
        );
        assert.equal(
          (await listGlobalPrivacyInvitations(domain, actor("global"), true))
            .items[0]?.status,
          "ACTIVE",
        );
        await assert.rejects(
          auth.query(
            'UPDATE auth."user" SET "twoFactorEnabled"=false WHERE id=\'global\'',
          ),
          { code: "42501" },
        );
      },
    );
    await t.test(
      "explicit global revocation is idempotent and cannot be undone by accepting again",
      async () => {
        await revokeGlobalPrivacy(
          domain,
          actor("operator"),
          globalGrant,
          "Finalización de funciones",
        );
        await revokeGlobalPrivacy(
          domain,
          actor("operator"),
          globalGrant,
          "Reintento de retirada",
        );
        await assert.rejects(allowed("global", null), { code: "FORBIDDEN" });
        await assert.rejects(
          acceptGlobalPrivacy(domain, actor("global"), globalGrant),
          { code: "NOT_FOUND" },
        );
        assert.equal(
          (
            await migration.query(
              "SELECT 1 FROM domain.global_privacy_permission_event WHERE invitation_id=$1 AND operation='REVOKE'",
              [globalGrant],
            )
          ).rowCount,
          1,
        );
      },
    );
    await t.test(
      "deactivation and suspension permanently withdraw global grants",
      async () => {
        for (const column of ["deactivated_at", "suspended_at"]) {
          const item = await inviteGlobal("global");
          await acceptGlobalPrivacy(domain, actor("global"), item.invitationId);
          await migration.query(
            `UPDATE auth.account_lifecycle SET ${column}=now() WHERE account_id='global'`,
          );
          await assert.rejects(allowed("global", null), {
            code: "ACCOUNT_INACTIVE",
          });
          await migration.query(
            `UPDATE auth.account_lifecycle SET ${column}=NULL WHERE account_id='global'`,
          );
          await assert.rejects(allowed("global", null), { code: "FORBIDDEN" });
          await assert.rejects(
            acceptGlobalPrivacy(domain, actor("global"), item.invitationId),
            { code: "NOT_FOUND" },
          );
        }
      },
    );
    await t.test(
      "issuer withdrawal invalidates pending invitations but not another person's accepted grant",
      async () => {
        const accepted = await inviteGlobal("global"),
          pending = await inviteGlobal("pending");
        await acceptGlobalPrivacy(
          domain,
          actor("global"),
          accepted.invitationId,
        );
        const successor = await inviteOperator(domain, actor("operator"), {
          accountId: "next-operator",
          expiresAt: expiresAt(),
        });
        await acceptOperatorInvitation(
          domain,
          actor("next-operator"),
          successor.invitationId,
        );
        await revokeOperator(
          domain,
          actor("operator"),
          "operator",
          "Relevo de operador",
        );
        await assert.rejects(
          acceptGlobalPrivacy(domain, actor("pending"), pending.invitationId),
          { code: "NOT_FOUND" },
        );
        await allowed("global", null);
        const reinvited = await inviteOperator(domain, actor("next-operator"), {
          accountId: "operator",
          expiresAt: expiresAt(),
        });
        await acceptOperatorInvitation(
          domain,
          actor("operator"),
          reinvited.invitationId,
        );
        await assert.rejects(
          acceptGlobalPrivacy(domain, actor("pending"), pending.invitationId),
          { code: "NOT_FOUND" },
        );
        const issuedBeforeClosure = await inviteGlobal("pending");
        await migration.query(
          "UPDATE auth.account_lifecycle SET suspended_at=now() WHERE account_id='operator'",
        );
        await migration.query(
          "UPDATE auth.account_lifecycle SET suspended_at=NULL WHERE account_id='operator'",
        );
        await assert.rejects(
          acceptGlobalPrivacy(
            domain,
            actor("pending"),
            issuedBeforeClosure.invitationId,
          ),
          { code: "NOT_FOUND" },
        );
        await allowed("global", null);
      },
    );
  });
});
