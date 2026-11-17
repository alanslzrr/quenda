import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { initializeOperator } from "../../scripts/lib/initialize-operator.ts";
import { transaction } from "../../src/database/transaction.ts";
import {
  inviteAdministrator,
  revokeAdministrator,
} from "../../src/modules/identity/invitations.ts";
import {
  acceptManager,
  inviteManager,
  revokeManager,
} from "../../src/modules/identity/manager.ts";
import {
  acceptAdministratorInvitation,
  createMunicipality,
} from "../../src/modules/identity/municipality.ts";
import { withDatabase } from "../helpers/postgres.ts";

const actor = (id: string) => ({
  accountId: id,
  email: `${id}@example.test`,
  sessionId: `session-${id}`,
  mfaVerifiedAt: new Date(),
});
const expiry = () => new Date(Date.now() + 3_600_000).toISOString();
async function retention(pool: Pool, tenant: string, key: string) {
  // Past the acceptance deadline of the accepted invitations, which still
  // anchors the account set.
  const cutoff = new Date(Date.now() + 7_200_000).toISOString();
  return transaction(
    pool,
    async (client) =>
      (
        await client.query(
          "SELECT domain.retention_municipal_action($1,'AUTHORITY',$2,$3) AS result",
          [tenant, key, cutoff],
        )
      ).rows[0].result,
  );
}

test("municipal authority retention removes the history of email invitations the account accepted", {
  timeout: 60_000,
}, async () => {
  await withDatabase(async ({ domain, auth, migration }) => {
    for (const id of ["operator", "first", "target"])
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
    const municipality = await createMunicipality(domain, actor("operator"), {
      name: "Concello de Conservación",
      timezone: "Europe/Madrid",
      administratorEmail: "first@example.test",
      invitationExpiresAt: expiry(),
    });
    const tenant = municipality.tenantId;
    await acceptAdministratorInvitation(
      domain,
      actor("first"),
      tenant,
      municipality.invitationId,
    );
    const administrator = await inviteAdministrator(
      domain,
      actor("first"),
      tenant,
      { email: "Target@Example.test", expiresAt: expiry() },
    );
    await acceptAdministratorInvitation(
      domain,
      actor("target"),
      tenant,
      administrator.invitationId,
    );
    const manager = await inviteManager(domain, actor("first"), tenant, {
      email: "target@example.test",
      expiresAt: expiry(),
      permissions: [{ operation: "RESERVATION_READ", unitId: null }],
    });
    await acceptManager(domain, actor("target"), tenant, manager.invitationId);
    // Both invitation events were recorded before any account was known.
    assert.deepEqual(
      (
        await migration.query(
          "SELECT subject_id FROM domain.identity_event WHERE tenant_id=$1 AND invitation_id=$2 AND operation='INVITE_ADMINISTRATOR'",
          [tenant, administrator.invitationId],
        )
      ).rows,
      [{ subject_id: null }],
    );
    await revokeManager(
      domain,
      actor("first"),
      tenant,
      manager.invitationId,
      "Fin del encargo",
    );
    await revokeAdministrator(
      domain,
      actor("first"),
      tenant,
      "target",
      "Fin del encargo",
    );

    const result = await retention(migration, tenant, "target");
    assert.equal(result.status, "APPLIED", JSON.stringify(result));
    assert.ok(
      result.payload.identityEvents.some(
        (event: { operation: string; subject_id: string | null }) =>
          event.operation === "INVITE_ADMINISTRATOR" &&
          event.subject_id === null,
      ),
    );
    assert.ok(
      result.payload.managerEvents.some(
        (event: { operation: string }) => event.operation === "INVITE_MANAGER",
      ),
    );
    for (const [sql, id] of [
      [
        "SELECT 1 FROM domain.administrator_invitation WHERE tenant_id=$1 AND id=$2",
        administrator.invitationId,
      ],
      [
        "SELECT 1 FROM domain.identity_event WHERE tenant_id=$1 AND invitation_id=$2",
        administrator.invitationId,
      ],
      [
        "SELECT 1 FROM domain.manager_invitation WHERE tenant_id=$1 AND id=$2",
        manager.invitationId,
      ],
      [
        "SELECT 1 FROM domain.manager_event WHERE tenant_id=$1 AND invitation_id=$2",
        manager.invitationId,
      ],
    ] as const)
      assert.equal((await migration.query(sql, [tenant, id])).rowCount, 0, sql);
    // The responsible administrator's own history is untouched.
    assert.equal(
      (
        await migration.query(
          "SELECT 1 FROM domain.administrator_invitation WHERE tenant_id=$1 AND id=$2 AND account_id='first'",
          [tenant, municipality.invitationId],
        )
      ).rowCount,
      1,
    );
    assert.equal(
      (await retention(migration, tenant, "target")).status,
      "ABSENT",
    );
  });
});
