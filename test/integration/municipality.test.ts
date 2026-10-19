import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { initializeOperator } from "../../scripts/lib/initialize-operator.ts";
import { transaction } from "../../src/database/transaction.ts";
import {
  acceptAdministratorInvitation,
  createMunicipality,
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
  });
});
