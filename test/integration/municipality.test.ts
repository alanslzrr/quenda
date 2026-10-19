import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { initializeOperator } from "../../scripts/lib/initialize-operator.ts";
import { transaction } from "../../src/database/transaction.ts";
import {
  acceptAdministratorInvitation,
  createMunicipality,
  inviteAdministrator,
  listOwnAdministratorInvitations,
  replaceInitialAdministratorInvitation,
  revokeAdministrator,
  revokeAdministratorInvitation,
} from "../../src/modules/identity/index.ts";
import { withDatabase } from "../helpers/postgres.ts";

const account = (id: string) => ({
  accountId: id,
  email: `${id}@example.test`,
  sessionId: `session-${id}`,
  mfaVerifiedAt: new Date(),
});
test("municipal creation and first administrator acceptance are atomic and isolated", {
  timeout: 60000,
}, async (t) => {
  await withDatabase(async ({ domain, auth, migration }) => {
    for (const id of ["operator", "admin-a", "admin-b", "other"]) {
      await auth.query(
        'INSERT INTO auth."user" (id, name, email, "emailVerified", "createdAt", "updatedAt", "twoFactorEnabled") VALUES ($1, $1, $2, true, now(), now(), true)',
        [id, `${id}@example.test`],
      );
    }
    const owner = await migration.connect();
    try {
      await initializeOperator(owner, "operator");
    } finally {
      owner.release();
    }
    const input = (id: string) => ({
      name: `Municipio ${id}`,
      timezone: "Europe/Madrid",
      administratorId: id,
      invitationExpiresAt: new Date(Date.now() + 3600000).toISOString(),
    });
    await t.test(
      "only MFA operator can create; invalid target rolls back municipality and events",
      async () => {
        await assert.rejects(
          createMunicipality(domain, account("other"), input("admin-a")),
          { code: "FORBIDDEN" },
        );
        await assert.rejects(
          createMunicipality(
            domain,
            { ...account("operator"), mfaVerifiedAt: null },
            input("admin-a"),
          ),
          { code: "FORBIDDEN" },
        );
        await assert.rejects(
          createMunicipality(domain, account("operator"), input("missing")),
          { code: "INVALID_INPUT" },
        );
        await assert.rejects(
          createMunicipality(domain, account("operator"), {
            ...input("admin-a"),
            timezone: "Invalid/Zone",
          }),
          { code: "INVALID_INPUT" },
        );
        await assert.rejects(
          createMunicipality(domain, account("operator"), {
            ...input("admin-a"),
            invitationExpiresAt: "2000-01-01T00:00:00Z",
          }),
          { code: "INVALID_INPUT" },
        );
        assert.equal(
          (await migration.query("SELECT * FROM domain.municipality")).rowCount,
          0,
        );
        assert.equal(
          (await migration.query("SELECT * FROM domain.identity_event"))
            .rowCount,
          0,
        );
      },
    );
    const a = await createMunicipality(
      domain,
      account("operator"),
      input("admin-a"),
    );
    const b = await createMunicipality(
      domain,
      account("operator"),
      input("admin-b"),
    );
    await t.test(
      "creation grants no administrator role and cannot be accepted by another account or scope",
      async () => {
        assert.equal(
          (
            await migration.query(
              "SELECT * FROM domain.municipal_administrator",
            )
          ).rowCount,
          0,
        );
        for (const [actor, tenant, invite] of [
          ["other", a.tenantId, a.invitationId],
          ["admin-a", b.tenantId, a.invitationId],
          ["admin-a", a.tenantId, randomUUID()],
        ] as const) {
          await assert.rejects(
            acceptAdministratorInvitation(
              domain,
              account(actor),
              tenant,
              invite,
            ),
            { code: "NOT_FOUND" },
          );
        }
        await assert.rejects(
          acceptAdministratorInvitation(
            domain,
            { ...account("admin-a"), mfaVerifiedAt: null },
            a.tenantId,
            a.invitationId,
          ),
          { code: "FORBIDDEN" },
        );
        assert.equal(
          (
            await migration.query(
              "SELECT * FROM domain.municipal_administrator",
            )
          ).rowCount,
          0,
        );
      },
    );
    await t.test(
      "acceptance persists profile, permission and audit exactly once",
      async () => {
        const simultaneous = await Promise.allSettled(
          [0, 1].map(() =>
            acceptAdministratorInvitation(
              domain,
              account("admin-a"),
              a.tenantId,
              a.invitationId,
            ),
          ),
        );
        assert.equal(
          simultaneous.filter((result) => result.status === "fulfilled").length,
          1,
        );
        const rejected = simultaneous.find(
          (result) => result.status === "rejected",
        );
        assert.ok(rejected?.status === "rejected");
        assert.equal(rejected.reason.code, "NOT_FOUND");
        await acceptAdministratorInvitation(
          domain,
          account("admin-b"),
          b.tenantId,
          b.invitationId,
        );
        await assert.rejects(
          acceptAdministratorInvitation(
            domain,
            account("admin-a"),
            a.tenantId,
            a.invitationId,
          ),
          { code: "NOT_FOUND" },
        );
        assert.equal(
          (
            await migration.query(
              "SELECT * FROM domain.municipal_administrator",
            )
          ).rowCount,
          2,
        );
        assert.equal(
          (
            await migration.query(
              "SELECT * FROM domain.identity_event WHERE operation = 'ACCEPT_ADMINISTRATOR'",
            )
          ).rowCount,
          2,
        );
        await transaction(
          domain,
          async (client) => {
            const profiles = await client.query(
              "SELECT * FROM domain.municipal_profile",
            );
            assert.equal(profiles.rowCount, 1);
            assert.equal(profiles.rows[0].account_id, "admin-a");
            assert.equal(
              (
                await client.query(
                  "SELECT * FROM domain.municipal_administrator WHERE tenant_id = $1",
                  [b.tenantId],
                )
              ).rowCount,
              0,
            );
          },
          { accountId: "admin-a", tenantId: a.tenantId },
        );
        await transaction(
          domain,
          async (client) => {
            assert.equal(
              (await client.query("SELECT * FROM domain.municipal_profile"))
                .rowCount,
              0,
            );
          },
          { accountId: "admin-a", tenantId: b.tenantId },
        );
        await transaction(
          domain,
          async (client) => {
            assert.equal(
              (await client.query("SELECT * FROM domain.municipal_profile"))
                .rowCount,
              0,
            );
          },
          { accountId: "operator", tenantId: a.tenantId },
        );
      },
    );
    await t.test(
      "expired and revoked invitations cannot confer privileges",
      async () => {
        for (const revoked of [false, true]) {
          const invitation = await createMunicipality(
            domain,
            account("operator"),
            input("other"),
          );
          if (revoked)
            await migration.query(
              "UPDATE domain.administrator_invitation SET revoked_at = now() WHERE id = $1",
              [invitation.invitationId],
            );
          else
            await migration.query(
              "UPDATE domain.administrator_invitation SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' WHERE id = $1",
              [invitation.invitationId],
            );
          await assert.rejects(
            acceptAdministratorInvitation(
              domain,
              account("other"),
              invitation.tenantId,
              invitation.invitationId,
            ),
            { code: "NOT_FOUND" },
          );
        }
        assert.equal(
          (
            await migration.query(
              "SELECT * FROM domain.municipal_administrator WHERE account_id = 'other'",
            )
          ).rowCount,
          0,
        );
        await assert.rejects(
          transaction(
            domain,
            (client) =>
              client.query(
                "INSERT INTO domain.municipal_administrator (tenant_id, account_id) VALUES ($1, 'other')",
                [a.tenantId],
              ),
            { accountId: "other", tenantId: a.tenantId },
          ),
          { code: "42501" },
        );
      },
    );

    await t.test(
      "municipal delegation and revocation require current authority and preserve tenant scope",
      async () => {
        const input = {
          accountId: "other",
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        };
        await assert.rejects(
          inviteAdministrator(domain, account("operator"), a.tenantId, input),
          { code: "FORBIDDEN" },
        );
        await assert.rejects(
          inviteAdministrator(domain, account("admin-b"), a.tenantId, input),
          { code: "FORBIDDEN" },
        );
        const invitation = await inviteAdministrator(
          domain,
          account("admin-a"),
          a.tenantId,
          input,
        );
        await assert.rejects(
          revokeAdministratorInvitation(
            domain,
            account("admin-b"),
            b.tenantId,
            invitation.invitationId,
          ),
          { code: "NOT_FOUND" },
        );
        await revokeAdministratorInvitation(
          domain,
          account("admin-a"),
          a.tenantId,
          invitation.invitationId,
        );
        await assert.rejects(
          acceptAdministratorInvitation(
            domain,
            account("other"),
            a.tenantId,
            invitation.invitationId,
          ),
          { code: "NOT_FOUND" },
        );
        const usable = await inviteAdministrator(
          domain,
          account("admin-a"),
          a.tenantId,
          input,
        );
        await acceptAdministratorInvitation(
          domain,
          account("other"),
          a.tenantId,
          usable.invitationId,
        );
        await assert.rejects(
          revokeAdministratorInvitation(
            domain,
            account("admin-a"),
            a.tenantId,
            usable.invitationId,
          ),
          { code: "NOT_FOUND" },
        );
        const pending = await inviteAdministrator(
          domain,
          account("other"),
          a.tenantId,
          { ...input, accountId: "admin-b" },
        );
        await assert.rejects(
          revokeAdministrator(
            domain,
            account("admin-b"),
            a.tenantId,
            "other",
            "Cambio de funciones",
          ),
          { code: "FORBIDDEN" },
        );
        await revokeAdministrator(
          domain,
          account("admin-a"),
          a.tenantId,
          "other",
          "Cambio de funciones",
        );
        await assert.rejects(
          inviteAdministrator(domain, account("other"), a.tenantId, input),
          { code: "FORBIDDEN" },
        );
        const restored = await inviteAdministrator(
          domain,
          account("admin-a"),
          a.tenantId,
          input,
        );
        await acceptAdministratorInvitation(
          domain,
          account("other"),
          a.tenantId,
          restored.invitationId,
        );
        // A restored issuer must not resurrect a previously invalidated invite.

        await assert.rejects(
          acceptAdministratorInvitation(
            domain,
            account("admin-b"),
            a.tenantId,
            pending.invitationId,
          ),
          { code: "NOT_FOUND" },
        );
        await assert.rejects(
          transaction(
            domain,
            async (connection) => {
              await connection.query(
                "INSERT INTO domain.municipal_profile (tenant_id,account_id) VALUES ($1,'admin-b') ON CONFLICT DO NOTHING",
                [a.tenantId],
              );
              await connection.query(
                "INSERT INTO domain.municipal_administrator (tenant_id,account_id) VALUES ($1,'admin-b')",
                [a.tenantId],
              );
            },
            { accountId: "admin-b", tenantId: a.tenantId },
          ),
          { code: "42501" },
        );
        const evidence = await migration.query(
          "SELECT reason FROM domain.identity_event WHERE operation = 'REVOKE_ADMINISTRATOR'",
        );
        assert.equal(evidence.rowCount, 1);
        assert.equal(evidence.rows[0].reason, "Cambio de funciones");
        const grant = await migration.query(
          "SELECT invitation_id, revoked_at FROM domain.municipal_administrator WHERE tenant_id = $1 AND account_id = 'other'",
          [a.tenantId],
        );
        assert.equal(grant.rows[0].invitation_id, restored.invitationId);
        assert.equal(grant.rows[0].revoked_at, null);
        assert.equal(
          (
            await migration.query(
              "SELECT * FROM domain.identity_event WHERE operation = 'REVOKE_INVITATION'",
            )
          ).rowCount,
          2,
        );
      },
    );

    await t.test(
      "own invitation projection crosses tenants without exposing other recipients and paginates",
      async () => {
        const empty = await listOwnAdministratorInvitations(
          domain,
          account("operator"),
        );
        assert.deepEqual(empty, { items: [], nextCursor: null });
        const rows = await listOwnAdministratorInvitations(
          domain,
          account("admin-a"),
        );
        assert.equal(rows.items.length, 1);
        assert.equal(rows.items[0]?.tenantId, a.tenantId);
        assert.equal(rows.items[0]?.status, "ACCEPTED");
        assert.equal(
          (
            await domain.query(
              "SELECT * FROM domain.own_administrator_invitations(NULL)",
            )
          ).rowCount,
          0,
        );
        for (let i = 0; i < 22; i++)
          await inviteAdministrator(domain, account("admin-a"), a.tenantId, {
            accountId: "admin-b",
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
          });
        const first = await listOwnAdministratorInvitations(
          domain,
          account("admin-b"),
        );
        assert.equal(first.items.length, 20);
        assert.ok(first.nextCursor);
        const second = await listOwnAdministratorInvitations(
          domain,
          account("admin-b"),
          first.nextCursor,
        );
        assert.equal(second.nextCursor, null);
        const all = [...first.items, ...second.items];
        assert.equal(all.length, 24);
        assert.equal(new Set(all.map((i) => i.invitationId)).size, 24);
        assert.ok(all.some((i) => i.tenantId === a.tenantId));
        assert.ok(all.some((i) => i.tenantId === b.tenantId));
      },
    );

    await t.test(
      "initial invitation replacement is atomic and closes permanently after first acceptance",
      async () => {
        const initial = await createMunicipality(
          domain,
          account("operator"),
          input("other"),
        );
        const replacement = {
          accountId: "other",
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
          reason: "Corrección de destinatario",
        };
        await assert.rejects(
          replaceInitialAdministratorInvitation(
            domain,
            account("admin-a"),
            initial.tenantId,
            replacement,
          ),
          { code: "FORBIDDEN" },
        );
        await assert.rejects(
          replaceInitialAdministratorInvitation(
            domain,
            account("operator"),
            initial.tenantId,
            { ...replacement, accountId: "missing" },
          ),
          { code: "INVALID_INPUT" },
        );
        assert.equal(
          (
            await migration.query(
              "SELECT revoked_at FROM domain.administrator_invitation WHERE id=$1",
              [initial.invitationId],
            )
          ).rows[0].revoked_at,
          null,
        );
        await migration.query(
          "UPDATE domain.administrator_invitation SET created_at=now()-interval '2 hours', expires_at=now()-interval '1 hour' WHERE id=$1",
          [initial.invitationId],
        );
        const next = await replaceInitialAdministratorInvitation(
          domain,
          account("operator"),
          initial.tenantId,
          replacement,
        );
        await assert.rejects(
          acceptAdministratorInvitation(
            domain,
            account("other"),
            initial.tenantId,
            initial.invitationId,
          ),
          { code: "NOT_FOUND" },
        );
        await acceptAdministratorInvitation(
          domain,
          account("other"),
          next.tenantId,
          next.invitationId,
        );
        await assert.rejects(
          replaceInitialAdministratorInvitation(
            domain,
            account("operator"),
            initial.tenantId,
            replacement,
          ),
          { code: "CONFLICT" },
        );
        await revokeAdministrator(
          domain,
          account("other"),
          initial.tenantId,
          "other",
          "Fin de funciones",
        );
        await assert.rejects(
          replaceInitialAdministratorInvitation(
            domain,
            account("operator"),
            initial.tenantId,
            replacement,
          ),
          { code: "CONFLICT" },
        );
        await assert.rejects(
          transaction(
            domain,
            (client) =>
              client.query(
                "INSERT INTO domain.administrator_invitation (tenant_id,id,account_id,invited_by,expires_at) VALUES ($1,$2,'other','operator',now()+interval '1 hour')",
                [initial.tenantId, randomUUID()],
              ),
            { accountId: "operator", tenantId: initial.tenantId },
          ),
          { code: "42501" },
        );
      },
    );
    await t.test(
      "concurrent first acceptance and replacement have only one effective outcome",
      async () => {
        const initial = await createMunicipality(
          domain,
          account("operator"),
          input("admin-a"),
        );
        const [accepted, replaced] = await Promise.allSettled([
          acceptAdministratorInvitation(
            domain,
            account("admin-a"),
            initial.tenantId,
            initial.invitationId,
          ),
          replaceInitialAdministratorInvitation(
            domain,
            account("operator"),
            initial.tenantId,
            {
              accountId: "admin-b",
              expiresAt: new Date(Date.now() + 3600000).toISOString(),
              reason: "Nuevo destinatario",
            },
          ),
        ]);
        assert.ok(accepted && replaced);
        assert.notEqual(accepted.status, replaced.status);
        if (replaced.status === "fulfilled") {
          await acceptAdministratorInvitation(
            domain,
            account("admin-b"),
            initial.tenantId,
            replaced.value.invitationId,
          );
        }
        assert.equal(
          (
            await migration.query(
              "SELECT * FROM domain.municipal_administrator WHERE tenant_id=$1",
              [initial.tenantId],
            )
          ).rowCount,
          1,
        );
      },
    );
  });
});
