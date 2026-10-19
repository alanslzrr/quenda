import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { initializeOperator } from "../../scripts/lib/initialize-operator.ts";
import { command } from "../../src/database/command.ts";
import { setTransactionContext } from "../../src/database/context.ts";
import { transaction } from "../../src/database/transaction.ts";
import {
  createFacility,
  createReservableUnit,
} from "../../src/modules/catalog/index.ts";
import {
  acceptAdministratorInvitation,
  acceptManager,
  createMunicipality,
  inviteAdministrator,
  inviteManager,
  listMunicipalManagerInvitations,
  listMunicipalProfiles,
  listOwnAdministratorInvitations,
  listOwnManagerInvitations,
  replaceInitialAdministratorInvitation,
  requirePermission,
  revokeAdministrator,
  revokeAdministratorInvitation,
  revokeManager,
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
    for (const id of [
      "operator",
      "admin-a",
      "admin-b",
      "other",
      "manager",
      "manager-other",
    ]) {
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

    await t.test(
      "role validity is separate from invitation expiry and expires without a worker",
      async () => {
        const initial = await createMunicipality(
          domain,
          account("operator"),
          input("admin-a"),
        );
        await acceptAdministratorInvitation(
          domain,
          account("admin-a"),
          initial.tenantId,
          initial.invitationId,
        );
        const roleExpiresAt = new Date(Date.now() + 3600000).toISOString();
        const temporary = await inviteAdministrator(
          domain,
          account("admin-a"),
          initial.tenantId,
          {
            accountId: "other",
            expiresAt: new Date(Date.now() + 7200000).toISOString(),
            roleExpiresAt,
          },
        );
        await acceptAdministratorInvitation(
          domain,
          account("other"),
          initial.tenantId,
          temporary.invitationId,
        );
        const granted = await migration.query(
          "SELECT expires_at FROM domain.municipal_administrator WHERE tenant_id=$1 AND account_id='other'",
          [initial.tenantId],
        );
        assert.equal(granted.rows[0].expires_at.toISOString(), roleExpiresAt);
        const delegated = await inviteAdministrator(
          domain,
          account("other"),
          initial.tenantId,
          {
            accountId: "admin-b",
            expiresAt: new Date(Date.now() + 7200000).toISOString(),
          },
        );
        await migration.query(
          "UPDATE domain.municipal_administrator SET granted_at=now()-interval '2 hours',expires_at=now()-interval '1 hour' WHERE tenant_id=$1 AND account_id='other'",
          [initial.tenantId],
        );
        await assert.rejects(
          inviteAdministrator(domain, account("other"), initial.tenantId, {
            accountId: "admin-b",
            expiresAt: roleExpiresAt,
          }),
          { code: "FORBIDDEN" },
        );
        await assert.rejects(
          acceptAdministratorInvitation(
            domain,
            account("admin-b"),
            initial.tenantId,
            delegated.invitationId,
          ),
          { code: "NOT_FOUND" },
        );
        const renewed = await inviteAdministrator(
          domain,
          account("admin-a"),
          initial.tenantId,
          { accountId: "other", expiresAt: roleExpiresAt, roleExpiresAt },
        );
        await acceptAdministratorInvitation(
          domain,
          account("other"),
          initial.tenantId,
          renewed.invitationId,
        );
        await assert.rejects(
          acceptAdministratorInvitation(
            domain,
            account("admin-b"),
            initial.tenantId,
            delegated.invitationId,
          ),
          { code: "NOT_FOUND" },
        );
        const expiredBeforeAcceptance = await inviteAdministrator(
          domain,
          account("admin-a"),
          initial.tenantId,
          { accountId: "admin-b", expiresAt: roleExpiresAt, roleExpiresAt },
        );
        await migration.query(
          "UPDATE domain.administrator_invitation SET created_at=now()-interval '2 hours',role_expires_at=now()-interval '1 hour' WHERE id=$1",
          [expiredBeforeAcceptance.invitationId],
        );
        await assert.rejects(
          acceptAdministratorInvitation(
            domain,
            account("admin-b"),
            initial.tenantId,
            expiredBeforeAcceptance.invitationId,
          ),
          { code: "NOT_FOUND" },
        );
      },
    );

    await t.test(
      "real catalog drafts enforce municipal scope and composite facility references",
      async () => {
        const facility = await createFacility(
          domain,
          account("admin-a"),
          a.tenantId,
          { name: " Pabellón " },
        );
        assert.equal(facility.name, "Pabellón");
        const unit = await createReservableUnit(
          domain,
          account("admin-a"),
          a.tenantId,
          facility.facilityId,
          { name: "Pista" },
        );
        assert.equal(unit.facilityId, facility.facilityId);
        await assert.rejects(
          createFacility(domain, account("operator"), a.tenantId, {
            name: "Otro",
          }),
          { code: "FORBIDDEN" },
        );
        await assert.rejects(
          createFacility(domain, account("admin-b"), a.tenantId, {
            name: "Otro",
          }),
          { code: "FORBIDDEN" },
        );
        await assert.rejects(
          createReservableUnit(
            domain,
            account("admin-b"),
            b.tenantId,
            facility.facilityId,
            { name: "Inconsistente" },
          ),
          { code: "NOT_FOUND" },
        );
        await assert.rejects(
          createFacility(domain, account("admin-a"), a.tenantId, {
            name: "  ",
          }),
          { code: "INVALID_INPUT" },
        );
        assert.equal(
          (await domain.query("SELECT * FROM domain.reservable_unit")).rowCount,
          0,
        );
        await transaction(
          domain,
          async (client) => {
            assert.equal(
              (await client.query("SELECT * FROM domain.reservable_unit"))
                .rowCount,
              1,
            );
            assert.equal(
              (await client.query("SELECT * FROM domain.catalog_event"))
                .rowCount,
              2,
            );
          },
          { accountId: "admin-a", tenantId: a.tenantId },
        );
        await transaction(
          domain,
          async (client) => {
            assert.equal(
              (await client.query("SELECT * FROM domain.reservable_unit"))
                .rowCount,
              0,
            );
          },
          { accountId: "admin-a", tenantId: b.tenantId },
        );
        assert.equal(
          (
            await migration.query(
              "SELECT * FROM domain.reservable_unit WHERE tenant_id=$1",
              [b.tenantId],
            )
          ).rowCount,
          0,
        );
        await assert.rejects(domain.query("DELETE FROM domain.catalog_event"), {
          code: "42501",
        });
      },
    );

    await t.test(
      "managers receive only accepted operations on authorized real units",
      async () => {
        const tenant = await createMunicipality(
          domain,
          account("operator"),
          input("admin-a"),
        );
        await acceptAdministratorInvitation(
          domain,
          account("admin-a"),
          tenant.tenantId,
          tenant.invitationId,
        );
        const facility = await createFacility(
          domain,
          account("admin-a"),
          tenant.tenantId,
          { name: "Centro" },
        );
        const one = await createReservableUnit(
          domain,
          account("admin-a"),
          tenant.tenantId,
          facility.facilityId,
          { name: "Uno" },
        );
        const two = await createReservableUnit(
          domain,
          account("admin-a"),
          tenant.tenantId,
          facility.facilityId,
          { name: "Dos" },
        );
        const payload = {
          accountId: "manager",
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
          roleExpiresAt: new Date(Date.now() + 7200000).toISOString(),
          permissions: [
            { operation: "RESERVATION_READ" as const, unitId: one.unitId },
            { operation: "UNIT_BLOCK" as const, unitId: one.unitId },
          ],
        };
        await assert.rejects(
          inviteManager(domain, account("admin-b"), tenant.tenantId, payload),
          { code: "FORBIDDEN" },
        );
        await assert.rejects(
          inviteManager(domain, account("admin-a"), tenant.tenantId, {
            ...payload,
            permissions: [{ operation: "UNIT_BLOCK", unitId: randomUUID() }],
          }),
          { code: "INVALID_INPUT" },
        );
        const foreignFacility = await createFacility(
          domain,
          account("admin-b"),
          b.tenantId,
          { name: "Centro B" },
        );
        const foreignUnit = await createReservableUnit(
          domain,
          account("admin-b"),
          b.tenantId,
          foreignFacility.facilityId,
          { name: "Unidad B" },
        );
        await assert.rejects(
          inviteManager(domain, account("admin-a"), tenant.tenantId, {
            ...payload,
            permissions: [
              { operation: "UNIT_BLOCK", unitId: foreignUnit.unitId },
            ],
          }),
          { code: "INVALID_INPUT" },
        );
        const grant = await inviteManager(
          domain,
          account("admin-a"),
          tenant.tenantId,
          payload,
        );
        const check = (
          operation: Parameters<typeof requirePermission>[2],
          unitId: string | null = one.unitId,
        ) =>
          transaction(
            domain,
            (c) => requirePermission(c, account("manager"), operation, unitId),
            { accountId: "manager", tenantId: tenant.tenantId },
          );
        await assert.rejects(check("RESERVATION_READ"), { code: "FORBIDDEN" });
        await assert.rejects(
          acceptManager(
            domain,
            account("manager-other"),
            tenant.tenantId,
            grant.invitationId,
          ),
          { code: "NOT_FOUND" },
        );
        await assert.rejects(
          acceptManager(
            domain,
            { ...account("manager"), mfaVerifiedAt: null },
            tenant.tenantId,
            grant.invitationId,
          ),
          { code: "FORBIDDEN" },
        );
        await acceptManager(
          domain,
          account("manager"),
          tenant.tenantId,
          grant.invitationId,
        );
        await check("RESERVATION_READ");
        await check("UNIT_BLOCK");
        await assert.rejects(check("RESERVATION_READ", two.unitId), {
          code: "FORBIDDEN",
        });
        await assert.rejects(check("RESERVATION_MANAGE"), {
          code: "FORBIDDEN",
        });
        await assert.rejects(check("RESERVATION_READ", null), {
          code: "FORBIDDEN",
        });
        await assert.rejects(
          transaction(
            domain,
            (c) =>
              requirePermission(
                c,
                account("manager"),
                "RESERVATION_READ",
                one.unitId,
              ),
            { accountId: "manager", tenantId: b.tenantId },
          ),
          { code: "FORBIDDEN" },
        );
        await assert.rejects(
          inviteAdministrator(domain, account("manager"), tenant.tenantId, {
            accountId: "manager-other",
            expiresAt: payload.expiresAt,
          }),
          { code: "FORBIDDEN" },
        );
        const creator = await inviteManager(
          domain,
          account("admin-a"),
          tenant.tenantId,
          {
            ...payload,
            permissions: [{ operation: "CATALOG_CREATE", unitId: null }],
          },
        );
        await acceptManager(
          domain,
          account("manager"),
          tenant.tenantId,
          creator.invitationId,
        );
        await createFacility(domain, account("manager"), tenant.tenantId, {
          name: "Alta por gestor autorizado",
        });
        await revokeManager(
          domain,
          account("admin-a"),
          tenant.tenantId,
          creator.invitationId,
          "Cambio de tareas",
        );
        await assert.rejects(
          createFacility(domain, account("manager"), tenant.tenantId, {
            name: "No autorizado",
          }),
          { code: "FORBIDDEN" },
        );
        await check("RESERVATION_READ");
        await migration.query(
          "UPDATE domain.manager_invitation SET created_at=now()-interval '2 hours',role_expires_at=now()-interval '1 hour' WHERE id=$1",
          [grant.invitationId],
        );
        await assert.rejects(check("RESERVATION_READ"), { code: "FORBIDDEN" });
        await assert.rejects(
          domain.query("UPDATE domain.manager_grant SET revoked_at=NULL"),
          { code: "42501" },
        );
        assert.equal(
          (await domain.query("SELECT * FROM domain.manager_permission"))
            .rowCount,
          0,
        );
      },
    );

    await t.test(
      "manager scope replacement preserves old authority until atomic acceptance and exposes only own grants",
      async () => {
        const tenant = await createMunicipality(
          domain,
          account("operator"),
          input("admin-a"),
        );
        await acceptAdministratorInvitation(
          domain,
          account("admin-a"),
          tenant.tenantId,
          tenant.invitationId,
        );
        const facility = await createFacility(
          domain,
          account("admin-a"),
          tenant.tenantId,
          { name: "Cambio" },
        );
        const unit = await createReservableUnit(
          domain,
          account("admin-a"),
          tenant.tenantId,
          facility.facilityId,
          { name: "Unidad" },
        );
        const base = {
          accountId: "manager-other",
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
          permissions: [
            { operation: "RESERVATION_READ" as const, unitId: unit.unitId },
          ],
        };
        const original = await inviteManager(
          domain,
          account("admin-a"),
          tenant.tenantId,
          base,
        );
        await acceptManager(
          domain,
          account("manager-other"),
          tenant.tenantId,
          original.invitationId,
        );
        const replacement = {
          ...base,
          replacesInvitationId: original.invitationId,
          reason: "Cambio de tareas",
          permissions: [
            { operation: "UNIT_BLOCK" as const, unitId: unit.unitId },
          ],
        };
        const next = await inviteManager(
          domain,
          account("admin-a"),
          tenant.tenantId,
          replacement,
        );
        const check = (operation: Parameters<typeof requirePermission>[2]) =>
          transaction(
            domain,
            (c) =>
              requirePermission(
                c,
                account("manager-other"),
                operation,
                unit.unitId,
              ),
            { accountId: "manager-other", tenantId: tenant.tenantId },
          );
        await check("RESERVATION_READ");
        await assert.rejects(check("UNIT_BLOCK"), { code: "FORBIDDEN" });
        const competitor = await inviteManager(
          domain,
          account("admin-a"),
          tenant.tenantId,
          replacement,
        );
        const outcomes = await Promise.allSettled(
          [next, competitor].map((inv) =>
            acceptManager(
              domain,
              account("manager-other"),
              tenant.tenantId,
              inv.invitationId,
            ),
          ),
        );
        assert.equal(
          outcomes.filter((o) => o.status === "fulfilled").length,
          1,
        );
        await check("UNIT_BLOCK");
        await assert.rejects(check("RESERVATION_READ"), { code: "FORBIDDEN" });
        const own = await listOwnManagerInvitations(
          domain,
          account("manager-other"),
        );
        const rows = own.items.filter(
          (item) => item.tenantId === tenant.tenantId,
        );
        assert.equal(rows.filter((item) => item.status === "ACTIVE").length, 1);
        assert.equal(
          rows.filter((item) => item.status === "INVALIDATED").length,
          1,
        );
        assert.equal(
          rows.find((item) => item.invitationId === original.invitationId)
            ?.status,
          "REVOKED",
        );
        for (let i = 0; i < 21; i++)
          await inviteManager(
            domain,
            account("admin-a"),
            tenant.tenantId,
            base,
          );
        const adminPage = await listMunicipalManagerInvitations(
          domain,
          account("admin-a"),
          tenant.tenantId,
        );
        assert.equal(adminPage.items.length, 20);
        assert.ok(adminPage.nextCursor);
        const adminNext = await listMunicipalManagerInvitations(
          domain,
          account("admin-a"),
          tenant.tenantId,
          adminPage.nextCursor,
        );
        assert.equal(adminNext.items.length, 4);
        assert.equal(adminNext.nextCursor, null);
        const all = [...adminPage.items, ...adminNext.items];
        assert.equal(new Set(all.map((row) => row.invitationId)).size, 24);
        assert.ok(
          all.every(
            (row) =>
              row.accountId === "manager-other" && row.invitedBy === "admin-a",
          ),
        );
        const old = all.find(
          (row) => row.invitationId === original.invitationId,
        );
        assert.ok(old?.acceptedAt);
        assert.ok(old?.revokedAt);
        assert.deepEqual(old.permissions, base.permissions);
        const active = all.filter((row) => row.acceptedAt && !row.revokedAt);
        assert.equal(active.length, 1);
        assert.equal(active[0]?.replacesInvitationId, original.invitationId);
        assert.deepEqual(active[0]?.permissions, replacement.permissions);
        for (const id of ["admin-b", "operator", "manager-other"])
          await assert.rejects(
            listMunicipalManagerInvitations(
              domain,
              account(id),
              tenant.tenantId,
            ),
            { code: "FORBIDDEN" },
          );
        const pageOne = await listOwnManagerInvitations(
          domain,
          account("manager-other"),
        );
        assert.equal(pageOne.items.length, 20);
        assert.ok(pageOne.nextCursor);
        const pageTwo = await listOwnManagerInvitations(
          domain,
          account("manager-other"),
          pageOne.nextCursor,
        );
        assert.equal(pageTwo.items.length, 4);
        assert.equal(pageTwo.nextCursor, null);
        assert.equal(
          new Set(
            [...pageOne.items, ...pageTwo.items].map(
              (item) => item.invitationId,
            ),
          ).size,
          24,
        );
        assert.deepEqual(
          await listOwnManagerInvitations(domain, account("operator")),
          { items: [], nextCursor: null },
        );
        assert.equal(
          (
            await domain.query(
              "SELECT * FROM domain.own_manager_invitations(NULL)",
            )
          ).rowCount,
          0,
        );
        assert.equal(
          (
            await migration.query(
              "SELECT * FROM domain.manager_event WHERE tenant_id=$1 AND operation='REPLACE_MANAGER'",
              [tenant.tenantId],
            )
          ).rowCount,
          1,
        );
      },
    );

    await t.test(
      "permission use and revocation obey both transaction orderings",
      async () => {
        const tenant = await createMunicipality(
          domain,
          account("operator"),
          input("admin-a"),
        );
        await acceptAdministratorInvitation(
          domain,
          account("admin-a"),
          tenant.tenantId,
          tenant.invitationId,
        );
        const grant = async () => {
          const invitation = await inviteManager(
            domain,
            account("admin-a"),
            tenant.tenantId,
            {
              accountId: "manager",
              expiresAt: new Date(Date.now() + 3600000).toISOString(),
              permissions: [{ operation: "CATALOG_CREATE", unitId: null }],
            },
          );
          await acceptManager(
            domain,
            account("manager"),
            tenant.tenantId,
            invitation.invitationId,
          );
          return invitation.invitationId;
        };
        const waitForBlockedPeer = async (holderPid: number) => {
          const deadline = Date.now() + 5000;
          while (Date.now() < deadline) {
            const locks = await migration.query(
              "SELECT 1 FROM pg_locks l WHERE NOT l.granted AND $1::integer=ANY(pg_blocking_pids(l.pid))",
              [holderPid],
            );
            if (locks.rowCount) return;
            await setTimeout(10);
          }
          assert.fail(
            "Expected a real PostgreSQL lock wait on the held authorization",
          );
        };
        const first = await grant();
        const holder = await domain.connect();
        let revoking: Promise<unknown> | undefined;
        try {
          await holder.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
          await setTransactionContext(holder, {
            accountId: "manager",
            tenantId: tenant.tenantId,
          });
          await requirePermission(holder, account("manager"), "CATALOG_CREATE");
          const pid = (await holder.query("SELECT pg_backend_pid() AS pid"))
            .rows[0].pid;
          revoking = revokeManager(
            domain,
            account("admin-a"),
            tenant.tenantId,
            first,
            "Fin de funciones",
          );
          // Attach rejection handling immediately, including assertion-failure paths.
          void revoking.catch(() => {});
          await waitForBlockedPeer(pid);
          // Authorization remains usable for this transaction until its commit.
          await requirePermission(holder, account("manager"), "CATALOG_CREATE");
          await holder.query("COMMIT");
          await revoking;
          await assert.rejects(
            command(
              domain,
              { accountId: "manager", tenantId: tenant.tenantId },
              (c) => requirePermission(c, account("manager"), "CATALOG_CREATE"),
            ),
            { code: "FORBIDDEN" },
          );
        } finally {
          await holder.query("ROLLBACK");
          holder.release();
          await revoking?.catch(() => {});
        }

        const second = await grant();
        const revoker = await domain.connect();
        let use: Promise<unknown> | undefined;
        let attempts = 0;
        try {
          await revoker.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
          await setTransactionContext(revoker, {
            accountId: "admin-a",
            tenantId: tenant.tenantId,
          });
          assert.equal(
            (
              await revoker.query(
                "SELECT domain.revoke_manager($1,$2) AS revoked",
                [second, "Retirada inmediata"],
              )
            ).rows[0].revoked,
            true,
          );
          const pid = (await revoker.query("SELECT pg_backend_pid() AS pid"))
            .rows[0].pid;
          use = command(
            domain,
            { accountId: "manager", tenantId: tenant.tenantId },
            async (c) => {
              attempts++;
              await requirePermission(c, account("manager"), "CATALOG_CREATE");
            },
          );
          void use.catch(() => {});
          await waitForBlockedPeer(pid);
          await revoker.query("COMMIT");
          await assert.rejects(use, { code: "FORBIDDEN" });
          assert.equal(
            attempts,
            2,
            "serialization retry must re-evaluate authorization in a fresh snapshot",
          );
        } finally {
          await revoker.query("ROLLBACK");
          revoker.release();
          await use?.catch(() => {});
        }
        assert.equal(
          (
            await migration.query(
              "SELECT count(*)::int AS n FROM domain.manager_event WHERE tenant_id=$1 AND operation='REVOKE_MANAGER'",
              [tenant.tenantId],
            )
          ).rows[0].n,
          2,
        );
      },
    );

    await t.test(
      "municipal profile queries are bounded and never become a global account directory",
      async () => {
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
        await acceptAdministratorInvitation(
          domain,
          account("admin-a"),
          a.tenantId,
          a.invitationId,
        );
        await acceptAdministratorInvitation(
          domain,
          account("admin-b"),
          b.tenantId,
          b.invitationId,
        );
        for (let i = 0; i < 22; i++) {
          const id = `profile-${i.toString().padStart(2, "0")}`;
          await auth.query(
            'INSERT INTO auth."user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,$1,$2,true,now(),now())',
            [id, `${id}@example.test`],
          );
          await migration.query(
            "INSERT INTO domain.municipal_profile(tenant_id,account_id) VALUES ($1,$2)",
            [a.tenantId, id],
          );
        }
        const first = await listMunicipalProfiles(
          domain,
          account("admin-a"),
          a.tenantId,
        );
        assert.equal(first.items.length, 20);
        assert.ok(first.nextCursor);
        const second = await listMunicipalProfiles(
          domain,
          account("admin-a"),
          a.tenantId,
          first.nextCursor,
        );
        assert.equal(second.items.length, 3);
        assert.equal(second.nextCursor, null);
        const rows = [...first.items, ...second.items];
        assert.equal(new Set(rows.map((row) => row.accountId)).size, 23);
        assert.ok(
          rows.every(
            (row) =>
              Object.keys(row).sort().join(",") === "accountId,createdAt",
          ),
        );
        assert.ok(
          !rows.some((row) =>
            ["operator", "admin-b", "other"].includes(row.accountId),
          ),
        );
        for (const id of ["admin-b", "operator", "manager", "other"])
          await assert.rejects(
            listMunicipalProfiles(domain, account(id), a.tenantId),
            { code: "FORBIDDEN" },
          );
        await assert.rejects(
          listMunicipalProfiles(domain, account("admin-a"), b.tenantId),
          { code: "FORBIDDEN" },
        );
        await assert.rejects(
          listMunicipalProfiles(
            domain,
            {
              ...account("admin-a"),
              mfaVerifiedAt: new Date(Date.now() - 360000),
            },
            a.tenantId,
          ),
          { code: "REAUTHENTICATION_REQUIRED" },
        );
        const ownB = await listMunicipalProfiles(
          domain,
          account("admin-b"),
          b.tenantId,
        );
        assert.deepEqual(
          ownB.items.map((row) => row.accountId),
          ["admin-b"],
        );
        await revokeAdministrator(
          domain,
          account("admin-a"),
          a.tenantId,
          "admin-a",
          "Fin de administración",
        );
        await assert.rejects(
          listMunicipalProfiles(domain, account("admin-a"), a.tenantId),
          { code: "FORBIDDEN" },
        );
      },
    );
  });
});
