import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client, type Pool } from "pg";
import { initializeOperator } from "../../scripts/lib/initialize-operator.ts";
import { migrate } from "../../scripts/lib/migrations.ts";
import { transaction } from "../../src/database/transaction.ts";
import { inviteAdministrator } from "../../src/modules/identity/invitations.ts";
import { inviteManager } from "../../src/modules/identity/manager.ts";
import { revokeMunicipalAccessForSecurity } from "../../src/modules/identity/municipal-continuity.ts";
import {
  acceptAdministratorInvitation,
  createMunicipality,
} from "../../src/modules/identity/municipality.ts";
import { inviteGlobalPrivacy } from "../../src/modules/identity/privacy-permissions.ts";
import { suspendAccount } from "../../src/modules/identity/security.ts";
import { withDatabase } from "../helpers/postgres.ts";

const actor = (id: string) => ({
  accountId: id,
  email: `${id}@example.test`,
  sessionId: `session-${id}`,
  mfaVerifiedAt: new Date(),
});
const expiry = () => new Date(Date.now() + 3_600_000).toISOString();

type Fixture = {
  tenant: string;
  administratorInvitation: string;
  managerInvitation: string;
  privacyInvitation: string;
};

// An administrator withdraws "pending", whose only tie with the municipality
// is a pending invitation to its verified address, and an operator suspends
// "holder", whose only global tie is a privacy invitation to its address.
async function withdrawAddressees(
  domain: Pool,
  auth: Pool,
  migration: Pool,
): Promise<Fixture> {
  for (const id of ["operator", "a", "pending", "holder"])
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
    name: "Concello de Enderezos",
    timezone: "Europe/Madrid",
    administratorEmail: "a@example.test",
    invitationExpiresAt: expiry(),
  });
  const tenant = municipality.tenantId;
  await acceptAdministratorInvitation(
    domain,
    actor("a"),
    tenant,
    municipality.invitationId,
  );
  const administrator = await inviteAdministrator(domain, actor("a"), tenant, {
    email: "pending@example.test",
    expiresAt: expiry(),
  });
  const manager = await inviteManager(domain, actor("a"), tenant, {
    email: "pending@example.test",
    expiresAt: expiry(),
    permissions: [{ operation: "RESERVATION_READ", unitId: null }],
  });
  await revokeMunicipalAccessForSecurity(
    domain,
    actor("a"),
    tenant,
    "pending",
    "Buzón comprometido",
  );
  const privacy = await inviteGlobalPrivacy(domain, actor("operator"), {
    email: "holder@example.test",
    permissions: ["PRIVACY_READ"],
    expiresAt: expiry(),
    reason: "Delegación aprobada",
  });
  await suspendAccount(
    domain,
    actor("operator"),
    "holder",
    "Compromiso verificado",
    randomUUID(),
  );
  return {
    tenant,
    administratorInvitation: administrator.invitationId,
    managerInvitation: manager.invitationId,
    privacyInvitation: privacy.invitationId,
  };
}

// Every audit row that names an account which never accepted an invitation.
async function namedAddressees(migration: Pool) {
  return (
    await migration.query<{ source: string; account: string }>(
      `SELECT 'identity' AS source,coalesce(subject_id,actor_id) AS account FROM domain.identity_event
        WHERE subject_id IN ('pending','holder') OR actor_id IN ('pending','holder')
       UNION ALL SELECT 'manager',actor_id FROM domain.manager_event WHERE actor_id IN ('pending','holder')
       UNION ALL SELECT 'privacy',actor_id FROM domain.global_privacy_permission_event WHERE actor_id IN ('pending','holder')
       ORDER BY 1,2`,
    )
  ).rows;
}

async function retention(pool: Pool, tenant: string | null, key: string) {
  const cutoff = new Date(Date.now() + 60_000).toISOString();
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

test("withdrawing an account revokes invitations to its address without recording the account", {
  timeout: 60_000,
}, async () => {
  await withDatabase(async ({ domain, auth, migration }) => {
    const fixture = await withdrawAddressees(domain, auth, migration);
    // The withdrawal stays audited on each invitation, with actor and reason.
    assert.deepEqual(
      (
        await migration.query(
          "SELECT actor_id,subject_id,reason FROM domain.identity_event WHERE tenant_id=$1 AND invitation_id=$2 AND operation='REVOKE_INVITATION'",
          [fixture.tenant, fixture.administratorInvitation],
        )
      ).rows,
      [{ actor_id: "a", subject_id: null, reason: "Buzón comprometido" }],
    );
    assert.deepEqual(
      (
        await migration.query(
          "SELECT actor_id,operation FROM domain.global_privacy_permission_event WHERE invitation_id=$1 ORDER BY occurred_at",
          [fixture.privacyInvitation],
        )
      ).rows,
      [
        { actor_id: "operator", operation: "INVITE" },
        { actor_id: null, operation: "ACCOUNT_WITHDRAWAL" },
      ],
    );
    assert.deepEqual(await namedAddressees(migration), []);
    // The address keys withdraw the addresses; nothing is left that links
    // either invitation to the accounts that used those addresses.
    for (const [tenant, key] of [
      [
        fixture.tenant,
        `address:administrator:${fixture.administratorInvitation}`,
      ],
      [fixture.tenant, `address:manager:${fixture.managerInvitation}`],
      [null, `address:privacy:${fixture.privacyInvitation}`],
    ] as const) {
      const result = await retention(migration, tenant, key);
      assert.equal(result.status, "APPLIED", JSON.stringify(result));
    }
    assert.deepEqual(
      (
        await migration.query(
          `SELECT recipient_email FROM domain.administrator_invitation WHERE id=$1
           UNION ALL SELECT recipient_email FROM domain.manager_invitation WHERE id=$2
           UNION ALL SELECT recipient_email FROM domain.global_privacy_invitation WHERE id=$3`,
          [
            fixture.administratorInvitation,
            fixture.managerInvitation,
            fixture.privacyInvitation,
          ],
        )
      ).rows,
      [
        { recipient_email: null },
        { recipient_email: null },
        { recipient_email: null },
      ],
    );
    assert.deepEqual(await namedAddressees(migration), []);
  });
});

test("0130 removes the account from earlier revocations of invitations it never accepted", {
  timeout: 60_000,
}, async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "quenda-address-events-upgrade-"),
  );
  await cp(path.resolve("db/migrations"), directory, { recursive: true });
  for (const name of await readdir(directory))
    if (name.endsWith(".sql") && name >= "0130_")
      await rm(path.join(directory, name));
  try {
    await withDatabase(async ({ domain, auth, migration }) => {
      const fixture = await withdrawAddressees(domain, auth, migration);
      // Rows written by the earlier functions name both accounts.
      assert.deepEqual(await namedAddressees(migration), [
        { source: "identity", account: "pending" },
        { source: "privacy", account: "holder" },
      ]);
      const owner = new Client({
        connectionString: migration.options.connectionString,
      });
      await owner.connect();
      try {
        await migrate(owner, path.resolve("db/migrations"));
      } finally {
        await owner.end();
      }
      assert.deepEqual(await namedAddressees(migration), []);
      // The revocations themselves are kept, with actor, reason and instant.
      assert.deepEqual(
        (
          await migration.query(
            `SELECT actor_id,reason FROM domain.identity_event WHERE tenant_id=$1 AND invitation_id=$2 AND operation='REVOKE_INVITATION'
             UNION ALL SELECT actor_id,reason FROM domain.global_privacy_permission_event WHERE invitation_id=$3 AND operation='ACCOUNT_WITHDRAWAL'`,
            [
              fixture.tenant,
              fixture.administratorInvitation,
              fixture.privacyInvitation,
            ],
          )
        ).rows,
        [
          { actor_id: "a", reason: "Buzón comprometido" },
          { actor_id: null, reason: null },
        ],
      );
      // The initial administrator's acceptance history still names it.
      assert.equal(
        (
          await migration.query(
            "SELECT 1 FROM domain.identity_event WHERE tenant_id=$1 AND subject_id='a'",
            [fixture.tenant],
          )
        ).rowCount,
        1,
      );
    }, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
