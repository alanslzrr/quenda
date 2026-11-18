import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Pool } from "pg";
import { initializeOperator } from "../../scripts/lib/initialize-operator.ts";
import { transaction } from "../../src/database/transaction.ts";
import {
  inviteAdministrator,
  listOwnAdministratorInvitations,
} from "../../src/modules/identity/invitations.ts";
import {
  acceptManager,
  inviteManager,
  listOwnManagerInvitations,
} from "../../src/modules/identity/manager.ts";
import { revokeAddressInvitationsForSecurity } from "../../src/modules/identity/municipal-continuity.ts";
import {
  acceptAdministratorInvitation,
  createMunicipality,
} from "../../src/modules/identity/municipality.ts";
import {
  acceptOperatorInvitation,
  inviteOperator,
  listOperatorInvitations,
  listOwnOperatorInvitations,
  revokeOperator,
  revokeOperatorInvitation,
} from "../../src/modules/identity/operator-lifecycle.ts";
import {
  acceptGlobalPrivacy,
  inviteGlobalPrivacy,
  listGlobalPrivacyInvitations,
} from "../../src/modules/identity/privacy-permissions.ts";
import {
  suspendAccount,
  suspendAccountByEmail,
} from "../../src/modules/identity/security.ts";
import { withDatabase } from "../helpers/postgres.ts";

const actor = (id: string, email = `${id}@example.test`) => ({
  accountId: id,
  email,
  sessionId: `session-${id}`,
  mfaVerifiedAt: new Date(),
});
const expiry = (ms = 3_600_000) => new Date(Date.now() + ms).toISOString();
const cutoff = () => new Date(Date.now() + 2000).toISOString();
const privacy = (email: string) => ({
  email,
  permissions: ["PRIVACY_READ" as const],
  expiresAt: expiry(),
  reason: "Delegación aprobada sobre identidad global",
});
async function retention(
  pool: Pool,
  key: string,
  tenant: string | null,
  before = cutoff(),
) {
  return transaction(
    pool,
    async (client) =>
      (
        await client.query(
          "SELECT domain.retention_municipal_action($1,'AUTHORITY',$2,$3) AS result",
          [tenant, key, before],
        )
      ).rows[0].result,
  );
}

test("operator and global privacy invitations follow a verified email and never reveal accounts", {
  timeout: 120_000,
}, async (t) => {
  await withDatabase(async ({ domain, auth, migration }) => {
    const users: Array<[string, string, boolean]> = [
      ["operator", "operator@example.test", true],
      ["deputy", "deputy@example.test", true],
      ["invitee", "invitee@example.test", true],
      ["other", "other@example.test", true],
      ["unverified", "unverified@example.test", false],
      ["mover", "mover-old@example.test", true],
      ["legacy", "legacy@example.test", true],
      ["compromised", "Compromised@Example.test", true],
      ["admin", "admin@example.test", true],
      ["staff", "staff@example.test", true],
    ];
    for (const [id, email, verified] of users)
      await auth.query(
        'INSERT INTO auth."user"(id,name,email,"emailVerified","createdAt","updatedAt","twoFactorEnabled") VALUES($1,$1,$2,$3,now(),now(),true)',
        [id, email, verified],
      );
    const owner = await migration.connect();
    try {
      await initializeOperator(owner, "operator");
    } finally {
      owner.release();
    }
    const operator = actor("operator");

    await t.test(
      "creation answers the same for registered, unverified and unknown addresses",
      async () => {
        const created: string[] = [];
        for (const email of [
          " Invitee@Example.TEST ",
          "unverified@example.test",
          "nobody@example.test",
        ]) {
          const operatorInvitation = await inviteOperator(domain, operator, {
            email,
            expiresAt: expiry(),
          });
          const privacyInvitation = await inviteGlobalPrivacy(
            domain,
            operator,
            privacy(email),
          );
          assert.deepEqual(Object.keys(operatorInvitation), ["invitationId"]);
          assert.deepEqual(Object.keys(privacyInvitation), ["invitationId"]);
          created.push(operatorInvitation.invitationId);
        }
        const stored = await migration.query(
          "SELECT account_id,recipient_email FROM domain.platform_operator_invitation WHERE id=ANY($1::uuid[]) ORDER BY recipient_email",
          [created],
        );
        assert.deepEqual(
          stored.rows.map((row) => [row.account_id, row.recipient_email]),
          [
            [null, "invitee@example.test"],
            [null, "nobody@example.test"],
            [null, "unverified@example.test"],
          ],
        );
        // The inviting event names no account before acceptance.
        assert.equal(
          (
            await migration.query(
              "SELECT 1 FROM domain.platform_operator_event WHERE invitation_id=ANY($1::uuid[]) AND subject_id IS NOT NULL",
              [created],
            )
          ).rowCount,
          0,
        );
        // The operator list shows the address it typed, never an account.
        const listed = await listOperatorInvitations(domain, operator);
        const invitee = listed.items.find(
          (item) => item.invitationId === created[0],
        );
        assert.equal(invitee?.recipientEmail, "invitee@example.test");
        assert.equal(invitee?.accountId, null);
        assert.equal(invitee?.accountName, null);
        await assert.rejects(
          inviteOperator(domain, operator, {
            email: "INVITEE@example.test",
            expiresAt: expiry(),
          }),
          { code: "ROLE_ALREADY_ACTIVE" },
        );
        for (const email of ["operator@example.test", "no-at-sign"])
          await assert.rejects(
            inviteOperator(domain, operator, { email, expiresAt: expiry() }),
            { code: "INVALID_INPUT" },
          );
      },
    );

    await t.test(
      "only the account whose verified email matches sees and accepts, then the address is dropped",
      async () => {
        for (const id of ["other", "unverified", "deputy"]) {
          assert.equal(
            (await listOwnOperatorInvitations(domain, actor(id))).items.length,
            0,
            id,
          );
          // An unverified account has no global listing at all.
          if (id === "unverified")
            await assert.rejects(
              listGlobalPrivacyInvitations(domain, actor(id), true),
              { code: "FORBIDDEN" },
            );
          else
            assert.equal(
              (await listGlobalPrivacyInvitations(domain, actor(id), true))
                .items.length,
              0,
              id,
            );
        }
        const own = await listOwnOperatorInvitations(domain, actor("invitee"));
        assert.equal(own.items.length, 1);
        const ownPrivacy = await listGlobalPrivacyInvitations(
          domain,
          actor("invitee"),
          true,
        );
        assert.equal(ownPrivacy.items.length, 1);
        const operatorInvitation = own.items[0]?.invitationId ?? "";
        const privacyInvitation = ownPrivacy.items[0]?.invitationId ?? "";
        await assert.rejects(
          acceptOperatorInvitation(domain, actor("other"), operatorInvitation),
          { code: "NOT_FOUND" },
        );
        await assert.rejects(
          acceptGlobalPrivacy(domain, actor("other"), privacyInvitation),
          { code: "NOT_FOUND" },
        );
        await acceptOperatorInvitation(
          domain,
          actor("invitee"),
          operatorInvitation,
        );
        await acceptGlobalPrivacy(domain, actor("invitee"), privacyInvitation);
        const bound = await migration.query(
          "SELECT account_id,recipient_email FROM domain.platform_operator_invitation WHERE id=$1 UNION ALL SELECT account_id,recipient_email FROM domain.global_privacy_invitation WHERE id=$2",
          [operatorInvitation, privacyInvitation],
        );
        assert.deepEqual(bound.rows, [
          { account_id: "invitee", recipient_email: null },
          { account_id: "invitee", recipient_email: null },
        ]);
        // A retry after acceptance is idempotent for the bound account.
        await acceptOperatorInvitation(
          domain,
          actor("invitee"),
          operatorInvitation,
        );
        const listed = await listGlobalPrivacyInvitations(
          domain,
          operator,
          false,
        );
        const accepted = listed.items.find(
          (item) => item.invitationId === privacyInvitation,
        );
        assert.equal(accepted?.status, "ACTIVE");
        assert.equal(accepted?.accountId, "invitee");
        assert.equal(accepted?.recipientEmail, null);
      },
    );

    await t.test(
      "a pending invitation follows the address when the verified email changes",
      async () => {
        const moving = await inviteOperator(domain, operator, {
          email: "mover-new@example.test",
          expiresAt: expiry(),
        });
        assert.equal(
          (await listOwnOperatorInvitations(domain, actor("mover"))).items
            .length,
          0,
        );
        await migration.query(
          `UPDATE auth."user" SET email='mover-new@example.test' WHERE id='mover'`,
        );
        assert.equal(
          (await listOwnOperatorInvitations(domain, actor("mover"))).items[0]
            ?.invitationId,
          moving.invitationId,
        );
        await revokeOperatorInvitation(
          domain,
          operator,
          moving.invitationId,
          "Ya no es necesaria",
        );
      },
    );

    await t.test(
      "invitations addressed to an account before this change stay valid",
      async () => {
        const operatorInvitation = randomUUID(),
          privacyInvitation = randomUUID();
        await migration.query(
          "INSERT INTO domain.platform_operator_invitation(id,account_id,invited_by,issuer_granted_at,expires_at) SELECT $1,'legacy',account_id,created_at,now()+interval '1 day' FROM domain.platform_operator WHERE account_id='operator'",
          [operatorInvitation],
        );
        await migration.query(
          "INSERT INTO domain.global_privacy_invitation(id,account_id,invited_by,issuer_granted_at,permissions,reason,expires_at) SELECT $1,'legacy',account_id,created_at,ARRAY['PRIVACY_READ'],'Legacy',now()+interval '1 day' FROM domain.platform_operator WHERE account_id='operator'",
          [privacyInvitation],
        );
        await assert.rejects(
          acceptGlobalPrivacy(domain, actor("other"), privacyInvitation),
          { code: "NOT_FOUND" },
        );
        await acceptGlobalPrivacy(domain, actor("legacy"), privacyInvitation);
        await acceptOperatorInvitation(
          domain,
          actor("legacy"),
          operatorInvitation,
        );
        assert.equal(
          (
            await migration.query(
              "SELECT 1 FROM domain.platform_operator WHERE account_id='legacy' AND revoked_at IS NULL",
            )
          ).rowCount,
          1,
        );
      },
    );

    await t.test(
      "suspending the account that owns the verified address withdraws invitations sent to it",
      async () => {
        const operatorInvitation = await inviteOperator(domain, operator, {
          email: "compromised@example.test",
          expiresAt: expiry(),
        });
        const privacyInvitation = await inviteGlobalPrivacy(
          domain,
          operator,
          privacy("compromised@example.test"),
        );
        const unrelated = await inviteOperator(domain, operator, {
          email: "somebody-else@example.test",
          expiresAt: expiry(),
        });
        await suspendAccount(
          domain,
          operator,
          "compromised",
          "Compromiso verificado",
          randomUUID(),
        );
        const rows = await migration.query<{
          id: string;
          revoked: boolean;
        }>(
          "SELECT id,revoked_at IS NOT NULL AS revoked FROM domain.platform_operator_invitation WHERE id=ANY($1::uuid[]) UNION ALL SELECT id,revoked_at IS NOT NULL FROM domain.global_privacy_invitation WHERE id=$2",
          [
            [operatorInvitation.invitationId, unrelated.invitationId],
            privacyInvitation.invitationId,
          ],
        );
        assert.deepEqual(
          Object.fromEntries(rows.rows.map((row) => [row.id, row.revoked])),
          {
            [operatorInvitation.invitationId]: true,
            [privacyInvitation.invitationId]: true,
            [unrelated.invitationId]: false,
          },
        );
        // The withdrawal is recorded on the invitation without naming the
        // account, which never accepted it.
        assert.deepEqual(
          (
            await migration.query(
              "SELECT actor_id FROM domain.global_privacy_permission_event WHERE invitation_id=$1 AND operation='ACCOUNT_WITHDRAWAL'",
              [privacyInvitation.invitationId],
            )
          ).rows,
          [{ actor_id: null }],
        );
        await revokeOperatorInvitation(
          domain,
          operator,
          unrelated.invitationId,
          "Fin de la prueba",
        );
      },
    );

    await t.test(
      "an operator suspends by exact email, and an unknown address answers like an unknown identifier",
      async () => {
        await auth.query(
          `INSERT INTO auth."user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES('lost','lost','lost@example.test',true,now(),now())`,
        );
        const failure = (promise: Promise<unknown>) =>
          promise.then(
            () => assert.fail("expected a failure"),
            (error: { code: string; message: string }) => ({
              code: error.code,
              message: error.message,
            }),
          );
        const unknownId = await failure(
          suspendAccount(
            domain,
            operator,
            "no-such-account",
            "Compromiso verificado",
            randomUUID(),
          ),
        );
        assert.equal(unknownId.code, "NOT_FOUND");
        for (const email of ["nobody@example.test", "lost@example", "lost"])
          assert.deepEqual(
            await failure(
              suspendAccountByEmail(
                domain,
                operator,
                email,
                "Compromiso verificado",
                randomUUID(),
              ),
            ),
            unknownId,
          );
        await assert.rejects(
          suspendAccountByEmail(
            domain,
            actor("other"),
            "lost@example.test",
            "Sin autoridad",
            randomUUID(),
          ),
          { code: "FORBIDDEN" },
        );
        await assert.rejects(
          suspendAccountByEmail(
            domain,
            { ...operator, mfaVerifiedAt: null },
            "lost@example.test",
            "Sin MFA reciente",
            randomUUID(),
          ),
        );
        const suspended = await suspendAccountByEmail(
          domain,
          operator,
          "  LOST@Example.TEST ",
          "Compromiso verificado",
          randomUUID(),
        );
        assert.equal(suspended.accountId, "lost");
        assert.ok(Number.isFinite(Date.parse(suspended.suspendedAt)));
        assert.deepEqual(
          (
            await migration.query(
              "SELECT actor_id,reason FROM auth.account_security_event WHERE subject_id='lost' AND operation='SUSPEND_ACCOUNT'",
            )
          ).rows,
          [{ actor_id: "operator", reason: "Compromiso verificado" }],
        );
        // A repeated suspension keeps the original instant, as by identifier.
        assert.equal(
          (
            await suspendAccountByEmail(
              domain,
              operator,
              "lost@example.test",
              "Repetición",
              randomUUID(),
            )
          ).suspendedAt,
          suspended.suspendedAt,
        );
      },
    );

    await t.test(
      "global retention withdraws the address of an unaccepted invitation and the history of an accepted one",
      async () => {
        const ended = await inviteOperator(domain, operator, {
          email: "ended@example.test",
          expiresAt: expiry(),
        });
        await revokeOperatorInvitation(
          domain,
          operator,
          ended.invitationId,
          "Retirada",
        );
        const expired = await inviteGlobalPrivacy(
          domain,
          operator,
          privacy("expired@example.test"),
        );
        await migration.query(
          "UPDATE domain.global_privacy_invitation SET created_at=now()-interval '2 hours',expires_at=now()-interval '1 hour' WHERE id=$1",
          [expired.invitationId],
        );
        const pending = await inviteGlobalPrivacy(
          domain,
          operator,
          privacy("waiting@example.test"),
        );
        const keys = {
          ended: `address:operator:${ended.invitationId}`,
          expired: `address:privacy:${expired.invitationId}`,
          pending: `address:privacy:${pending.invitationId}`,
        };
        const candidates = (
          await migration.query<{ target_key: string; subject_id: unknown }>(
            "SELECT * FROM domain.retention_municipal_candidates(NULL,'AUTHORITY',$1,1000)",
            [cutoff()],
          )
        ).rows;
        for (const key of [keys.ended, keys.expired])
          assert.equal(
            candidates.find((row) => row.target_key === key)?.subject_id,
            null,
            key,
          );
        assert.ok(!candidates.some((row) => row.target_key === keys.pending));
        // Address-only invitations never surface as an account set.
        assert.ok(
          candidates.every((row) => typeof row.target_key === "string"),
        );
        assert.equal(
          (await retention(migration, keys.pending, null)).reason,
          "NOT_DUE",
        );
        const tenant = randomUUID();
        assert.equal(
          (await retention(migration, keys.ended, tenant)).reason,
          "GLOBAL_SECURITY_SCOPE_REQUIRED",
        );
        const applied = await retention(migration, keys.ended, null);
        assert.equal(applied.status, "APPLIED");
        assert.equal(
          applied.payload.operatorInvitation.recipient_email,
          "ended@example.test",
        );
        const privacyApplied = await retention(migration, keys.expired, null);
        assert.equal(
          privacyApplied.payload.privacyInvitation.recipient_email,
          "expired@example.test",
        );
        assert.deepEqual(
          (
            await migration.query(
              "SELECT recipient_email FROM domain.platform_operator_invitation WHERE id=$1 UNION ALL SELECT recipient_email FROM domain.global_privacy_invitation WHERE id=ANY($2::uuid[]) ORDER BY 1",
              [
                ended.invitationId,
                [expired.invitationId, pending.invitationId],
              ],
            )
          ).rows.map((row) => row.recipient_email),
          ["waiting@example.test", null, null],
        );
        assert.equal(
          (await retention(migration, keys.ended, null)).status,
          "ABSENT",
        );
        // The account that accepted an address invitation keeps a removable
        // history: its invitation event has no subject but is withdrawn too.
        await revokeOperator(domain, operator, "invitee", "Fin del encargo");
        await migration.query(
          "UPDATE domain.global_privacy_invitation SET revoked_at=now() WHERE account_id='invitee'",
        );
        // The accepted invitation still anchors at its acceptance deadline.
        const history = await retention(
          migration,
          "invitee",
          null,
          expiry(7_200_000),
        );
        assert.equal(history.status, "APPLIED", JSON.stringify(history));
        assert.ok(
          history.payload.operatorEvents.some(
            (event: { operation: string; subject_id: string | null }) =>
              event.operation === "INVITE_OPERATOR" &&
              event.subject_id === null,
          ),
        );
      },
    );

    await t.test(
      "a municipal administrator withdraws pending invitations to an address for security",
      async () => {
        const municipality = await createMunicipality(domain, operator, {
          name: "Address withdrawal",
          timezone: "Europe/Madrid",
          administratorEmail: "admin@example.test",
          invitationExpiresAt: expiry(),
        });
        const tenant = municipality.tenantId;
        await acceptAdministratorInvitation(
          domain,
          actor("admin"),
          tenant,
          municipality.invitationId,
        );
        const permissions = [
          { operation: "RESERVATION_READ" as const, unitId: null },
        ];
        const staff = await inviteManager(domain, actor("admin"), tenant, {
          email: "staff@example.test",
          expiresAt: expiry(),
          permissions,
        });
        await acceptManager(domain, actor("staff"), tenant, staff.invitationId);
        const administrator = await inviteAdministrator(
          domain,
          actor("admin"),
          tenant,
          { email: "suspicious@example.test", expiresAt: expiry() },
        );
        const manager = await inviteManager(domain, actor("admin"), tenant, {
          email: "Suspicious@Example.test",
          expiresAt: expiry(),
          permissions,
        });
        const kept = await inviteManager(domain, actor("admin"), tenant, {
          email: "kept@example.test",
          expiresAt: expiry(),
          permissions,
        });
        await assert.rejects(
          revokeAddressInvitationsForSecurity(
            domain,
            actor("staff"),
            tenant,
            "suspicious@example.test",
            "Sin autoridad",
          ),
          { code: "FORBIDDEN" },
        );
        await assert.rejects(
          revokeAddressInvitationsForSecurity(
            domain,
            actor("admin"),
            tenant,
            "not-an-address",
            "Correo no válido",
          ),
          { code: "INVALID_INPUT" },
        );
        assert.deepEqual(
          await revokeAddressInvitationsForSecurity(
            domain,
            actor("admin"),
            tenant,
            " SUSPICIOUS@example.test",
            "Dirección comprometida",
          ),
          { tenantId: tenant, email: "suspicious@example.test" },
        );
        const state = await migration.query<{ id: string; revoked: boolean }>(
          "SELECT id,revoked_at IS NOT NULL AS revoked FROM domain.administrator_invitation WHERE id=$1 UNION ALL SELECT id,revoked_at IS NOT NULL FROM domain.manager_invitation WHERE id=ANY($2::uuid[])",
          [
            administrator.invitationId,
            [manager.invitationId, kept.invitationId, staff.invitationId],
          ],
        );
        assert.deepEqual(
          Object.fromEntries(state.rows.map((row) => [row.id, row.revoked])),
          {
            [administrator.invitationId]: true,
            [manager.invitationId]: true,
            [kept.invitationId]: false,
            [staff.invitationId]: false,
          },
        );
        assert.deepEqual(
          (
            await migration.query(
              "SELECT operation,subject_id,reason FROM domain.identity_event WHERE tenant_id=$1 AND invitation_id=$2 AND operation='REVOKE_INVITATION'",
              [tenant, administrator.invitationId],
            )
          ).rows,
          [
            {
              operation: "REVOKE_INVITATION",
              subject_id: null,
              reason: "Dirección comprometida",
            },
          ],
        );
        assert.equal(
          (
            await migration.query(
              "SELECT 1 FROM domain.manager_event WHERE tenant_id=$1 AND invitation_id=$2 AND operation='REVOKE_MANAGER_INVITATION' AND reason='Dirección comprometida'",
              [tenant, manager.invitationId],
            )
          ).rowCount,
          1,
        );
        // Nothing pending remains for that address: the answer is NOT_FOUND,
        // with no account involved either way.
        await assert.rejects(
          revokeAddressInvitationsForSecurity(
            domain,
            actor("admin"),
            tenant,
            "suspicious@example.test",
            "Repetición",
          ),
          { code: "NOT_FOUND" },
        );
        await assert.rejects(
          revokeAddressInvitationsForSecurity(
            domain,
            actor("admin"),
            tenant,
            "staff@example.test",
            "Concesión ya aceptada",
          ),
          { code: "NOT_FOUND" },
        );
        await auth.query(
          `INSERT INTO auth."user"(id,name,email,"emailVerified","createdAt","updatedAt","twoFactorEnabled") VALUES('suspicious','suspicious','suspicious@example.test',true,now(),now(),true)`,
        );
        assert.equal(
          (
            await listOwnAdministratorInvitations(domain, actor("suspicious"))
          ).items.find(
            (item) => item.invitationId === administrator.invitationId,
          )?.status,
          "REVOKED",
        );
        assert.ok(
          !(
            await listOwnManagerInvitations(domain, actor("suspicious"))
          ).items.some(
            (item) =>
              item.invitationId === manager.invitationId &&
              item.status === "PENDING",
          ),
        );
      },
    );

    await t.test(
      "withdrawal by address leaves invitations that already expired untouched",
      async () => {
        const municipality = await createMunicipality(domain, operator, {
          name: "Lapsed address withdrawal",
          timezone: "Europe/Madrid",
          administratorEmail: "admin@example.test",
          invitationExpiresAt: expiry(),
        });
        const tenant = municipality.tenantId;
        await acceptAdministratorInvitation(
          domain,
          actor("admin"),
          tenant,
          municipality.invitationId,
        );
        const administrator = await inviteAdministrator(
          domain,
          actor("admin"),
          tenant,
          { email: "lapsed@example.test", expiresAt: expiry() },
        );
        const manager = await inviteManager(domain, actor("admin"), tenant, {
          email: "lapsed@example.test",
          expiresAt: expiry(),
          permissions: [{ operation: "RESERVATION_READ", unitId: null }],
        });
        const roleEnded = await inviteManager(domain, actor("admin"), tenant, {
          email: "lapsed@example.test",
          expiresAt: expiry(),
          permissions: [{ operation: "UNIT_BLOCK", unitId: null }],
        });
        // Acceptance deadlines, and the role of the last one, are already past.
        await migration.query(
          "UPDATE domain.administrator_invitation SET created_at=now()-interval '2 hours',expires_at=now()-interval '1 hour' WHERE id=$1",
          [administrator.invitationId],
        );
        await migration.query(
          "UPDATE domain.manager_invitation SET created_at=now()-interval '2 hours',expires_at=now()-interval '1 hour' WHERE id=$1",
          [manager.invitationId],
        );
        await migration.query(
          "UPDATE domain.manager_invitation SET created_at=now()-interval '2 hours',role_expires_at=now()-interval '1 hour' WHERE id=$1",
          [roleEnded.invitationId],
        );
        await assert.rejects(
          revokeAddressInvitationsForSecurity(
            domain,
            actor("admin"),
            tenant,
            "lapsed@example.test",
            "Dirección comprometida",
          ),
          { code: "NOT_FOUND" },
        );
        // Their revocation instant, which anchors address retention, stays
        // empty and no withdrawal is recorded.
        assert.deepEqual(
          (
            await migration.query(
              `SELECT revoked_at FROM domain.administrator_invitation WHERE id=$1
               UNION ALL SELECT revoked_at FROM domain.manager_invitation WHERE id=ANY($2::uuid[])`,
              [
                administrator.invitationId,
                [manager.invitationId, roleEnded.invitationId],
              ],
            )
          ).rows,
          [{ revoked_at: null }, { revoked_at: null }, { revoked_at: null }],
        );
        assert.equal(
          (
            await migration.query(
              `SELECT 1 FROM domain.identity_event WHERE tenant_id=$1 AND operation='REVOKE_INVITATION'
               UNION ALL SELECT 1 FROM domain.manager_event WHERE tenant_id=$1 AND operation='REVOKE_MANAGER_INVITATION'`,
              [tenant],
            )
          ).rowCount,
          0,
        );
        // A pending invitation to the same address is still withdrawn.
        const pending = await inviteManager(domain, actor("admin"), tenant, {
          email: "lapsed@example.test",
          expiresAt: expiry(),
          permissions: [{ operation: "RESERVATION_READ", unitId: null }],
        });
        await revokeAddressInvitationsForSecurity(
          domain,
          actor("admin"),
          tenant,
          "lapsed@example.test",
          "Dirección comprometida",
        );
        assert.deepEqual(
          (
            await migration.query(
              "SELECT id FROM domain.manager_invitation WHERE tenant_id=$1 AND revoked_at IS NOT NULL",
              [tenant],
            )
          ).rows,
          [{ id: pending.invitationId }],
        );
      },
    );
  });
});
