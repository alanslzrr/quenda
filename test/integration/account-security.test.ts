import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { initializeOperator } from "../../scripts/lib/initialize-operator.ts";
import { recoverAccount } from "../../scripts/lib/recover-account.ts";
import { deactivateAccount } from "../../src/modules/identity/deactivation.ts";
import {
  acceptAdministratorInvitation,
  createMunicipality,
} from "../../src/modules/identity/municipality.ts";
import { inviteOperator } from "../../src/modules/identity/operator-lifecycle.ts";
import { suspendAccount } from "../../src/modules/identity/security.ts";
import { createReservation } from "../../src/modules/reservations/create.ts";
import { withDatabase } from "../helpers/postgres.ts";
import {
  initialAcceptance,
  seedUsageRules,
} from "../helpers/usage-rules-fixture.ts";

const actor = (id: string) => ({
  accountId: id,
  email: `${id}@example.test`,
  sessionId: `session-${id}`,
  mfaVerifiedAt: new Date(),
});
const evidence = {
  performedBy: "Verified operational responder",
  identityReference: "SYNTHETIC-IDENTITY-42",
  remediationReference: "SYNTHETIC-REMEDIATION-42",
  reason:
    "Recovery after independently verified identity and credential replacement",
};

test("security suspension revokes global access without releasing bookings and recovery restores no authority", {
  timeout: 60000,
}, async (t) => {
  await withDatabase(async ({ auth, domain, migration }) => {
    for (const id of ["operator", "holder", "outsider"]) {
      await auth.query(
        'INSERT INTO auth."user"(id,name,email,"emailVerified","twoFactorEnabled","createdAt","updatedAt") VALUES($1,$1,$2,true,true,now(),now())',
        [id, `${id}@example.test`],
      );
      await auth.query(
        'INSERT INTO auth.account(id,"accountId","providerId","userId",password,"updatedAt") VALUES($1,$1,\'credential\',$1,\'initial-password-hash\',now())',
        [id],
      );
      await auth.query(
        'INSERT INTO auth."twoFactor"(id,secret,"backupCodes","userId",verified) VALUES($1,\'initial-mfa-secret\',\'initial-backup-codes\',$1,true)',
        [id],
      );
      await auth.query(
        'INSERT INTO auth.session(id,"expiresAt",token,"updatedAt","userId","mfaVerifiedAt") VALUES($1,now()+interval \'1 day\',$1,now(),$2,now())',
        [`session-${id}`, id],
      );
    }
    const owner = await migration.connect();
    try {
      await initializeOperator(owner, "operator");
      const { tenantId, invitationId } = await createMunicipality(
        domain,
        actor("operator"),
        {
          name: "Security municipality",
          timezone: "Europe/Madrid",
          administratorEmail: "holder@example.test",
          invitationExpiresAt: new Date(Date.now() + 86400000).toISOString(),
        },
      );
      await acceptAdministratorInvitation(
        domain,
        actor("holder"),
        tenantId,
        invitationId,
      );
      const pending = await inviteOperator(domain, actor("operator"), {
        accountId: "holder",
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      });
      const facilityId = randomUUID(),
        unitId = randomUUID();
      await migration.query(
        "INSERT INTO domain.facility(tenant_id,id,name,published_at) VALUES($1,$2,'Security fixture',now())",
        [tenantId, facilityId],
      );
      await migration.query(
        "INSERT INTO domain.reservable_unit(tenant_id,id,facility_id,name) VALUES($1,$2,$3,'Security fixture')",
        [tenantId, unitId, facilityId],
      );
      await migration.query(
        "INSERT INTO domain.unit_calendar_version(tenant_id,unit_id,version,minimum_minutes,maximum_minutes,step_minutes,weekly,exceptions,actor_id,reason) VALUES($1,$2,1,60,60,60,$3,'[]','holder','Fixture')",
        [
          tenantId,
          unitId,
          JSON.stringify(
            Array.from({ length: 7 }, (_, i) => ({
              day: i + 1,
              startMinute: 0,
              endMinute: 1440,
            })),
          ),
        ],
      );
      await seedUsageRules(migration, tenantId, unitId, "holder");
      await migration.query(
        "UPDATE domain.reservable_unit SET calendar_version=1,published_at=now() WHERE tenant_id=$1 AND id=$2",
        [tenantId, unitId],
      );
      const start = new Date();
      start.setUTCDate(start.getUTCDate() + 3);
      start.setUTCHours(12, 0, 0, 0);
      const reservation = await createReservation(
        domain,
        actor("holder"),
        tenantId,
        randomUUID(),
        {
          unitId,
          startsAt: start.toISOString(),
          endsAt: new Date(start.getTime() + 3600000).toISOString(),
          acceptance: initialAcceptance,
        },
        randomUUID(),
        3600,
      );
      const before = (
        await migration.query("SELECT * FROM domain.reservation WHERE id=$1", [
          reservation.result.id,
        ])
      ).rows[0];
      await t.test(
        "proof and emergency recovery capabilities cannot be invoked by the web domain role",
        async () => {
          await assert.rejects(
            deactivateAccount(
              domain,
              actor("outsider"),
              randomUUID(),
              "0".repeat(64),
            ),
            { code: "ACCOUNT_PASSWORD_REQUIRED" },
          );
          for (const sql of [
            "SELECT * FROM auth.account_deactivation_proof",
            "SELECT * FROM auth.account_security_event",
            "SELECT auth.recover_account('holder','operator','identity','remediation','reason',gen_random_uuid())",
            "SELECT auth.issue_deactivation_proof('holder','session-holder','initial-password-hash',repeat('0',64))",
          ])
            await assert.rejects(domain.query(sql), { code: "42501" });
          await assert.rejects(
            suspendAccount(
              domain,
              actor("outsider"),
              "holder",
              "Compromised",
              randomUUID(),
            ),
            { code: "FORBIDDEN" },
          );
          await assert.rejects(
            suspendAccount(
              domain,
              { ...actor("operator"), mfaVerifiedAt: null },
              "holder",
              "Compromised",
              randomUUID(),
            ),
            { code: "FORBIDDEN" },
          );
        },
      );
      await t.test(
        "suspension closes sessions and authority while retaining reservations and occupancy",
        async () => {
          const suspension = await suspendAccount(
            domain,
            actor("operator"),
            "holder",
            "Verified account compromise",
            randomUUID(),
          );
          assert.equal(
            (
              await suspendAccount(
                domain,
                actor("operator"),
                "holder",
                "Repeated containment request",
                randomUUID(),
              )
            ).suspendedAt,
            suspension.suspendedAt,
          );
          assert.equal(
            (
              await migration.query(
                "SELECT 1 FROM auth.session WHERE \"userId\"='holder'",
              )
            ).rowCount,
            0,
          );
          assert.equal(
            (
              await migration.query(
                "SELECT 1 FROM domain.municipal_administrator WHERE account_id='holder' AND revoked_at IS NULL",
              )
            ).rowCount,
            0,
          );
          assert.ok(
            (
              await migration.query(
                "SELECT revoked_at FROM domain.platform_operator_invitation WHERE id=$1",
                [pending.invitationId],
              )
            ).rows[0].revoked_at,
          );
          assert.deepEqual(
            (
              await migration.query(
                "SELECT * FROM domain.reservation WHERE id=$1",
                [reservation.result.id],
              )
            ).rows[0],
            before,
          );
          assert.equal(
            (
              await migration.query(
                "SELECT 1 FROM domain.occupancy WHERE reservation_id=$1 AND released_at IS NULL",
                [reservation.result.id],
              )
            ).rowCount,
            1,
          );
          assert.equal(
            (
              await migration.query(
                "SELECT 1 FROM auth.account_security_event WHERE subject_id='holder' AND operation='SUSPEND_ACCOUNT'",
              )
            ).rowCount,
            1,
          );
          await assert.rejects(
            auth.query(
              "INSERT INTO auth.session(id,\"expiresAt\",token,\"updatedAt\",\"userId\") VALUES('new-session',now()+interval '1 day','new-session',now(),'holder')",
            ),
            { code: "42501" },
          );
          await assert.rejects(
            deactivateAccount(
              domain,
              actor("holder"),
              randomUUID(),
              "0".repeat(64),
            ),
            { code: "ACCOUNT_INACTIVE" },
          );
        },
      );
      await t.test(
        "recovery requires replacement password, verified MFA and backup codes, never revives roles",
        async () => {
          await assert.rejects(recoverAccount(owner, "holder", evidence), {
            code: "42501",
          });
          await migration.query(
            "UPDATE auth.account SET password='replacement-password-hash' WHERE \"userId\"='holder'",
          );
          await assert.rejects(recoverAccount(owner, "holder", evidence), {
            code: "42501",
          });
          await migration.query(
            "UPDATE auth.\"twoFactor\" SET secret='replacement-mfa-secret' WHERE \"userId\"='holder'",
          );
          await assert.rejects(recoverAccount(owner, "holder", evidence), {
            code: "42501",
          });
          await migration.query(
            'UPDATE auth."twoFactor" SET "backupCodes"=\'replacement-backup-codes\',verified=false WHERE "userId"=\'holder\'',
          );
          await assert.rejects(recoverAccount(owner, "holder", evidence), {
            code: "42501",
          });
          await migration.query(
            'UPDATE auth."twoFactor" SET verified=true WHERE "userId"=\'holder\'',
          );
          await recoverAccount(owner, "holder", evidence);
          assert.equal(
            (
              await migration.query(
                "SELECT domain.account_enabled('holder') AS enabled",
              )
            ).rows[0].enabled,
            true,
          );
          assert.equal(
            (
              await migration.query(
                "SELECT 1 FROM domain.municipal_administrator WHERE account_id='holder' AND revoked_at IS NULL",
              )
            ).rowCount,
            0,
          );
          assert.equal(
            (
              await migration.query(
                "SELECT 1 FROM domain.platform_operator WHERE account_id='holder' AND revoked_at IS NULL",
              )
            ).rowCount,
            0,
          );
          assert.equal(
            (
              await migration.query(
                "SELECT 1 FROM auth.session WHERE \"userId\"='holder'",
              )
            ).rowCount,
            0,
          );
          assert.deepEqual(
            (
              await migration.query(
                "SELECT * FROM domain.reservation WHERE id=$1",
                [reservation.result.id],
              )
            ).rows[0],
            before,
          );
          assert.equal(
            (
              await migration.query(
                "SELECT 1 FROM auth.account_security_event WHERE subject_id='holder' AND operation='RECOVER_ACCOUNT'",
              )
            ).rowCount,
            1,
          );
        },
      );
      await t.test(
        "the last operator may be suspended immediately, without reopening bootstrap",
        async () => {
          await suspendAccount(
            domain,
            actor("operator"),
            "operator",
            "Contain the sole compromised operator",
            randomUUID(),
          );
          assert.equal(
            (
              await migration.query(
                "SELECT 1 FROM domain.platform_operator WHERE revoked_at IS NULL",
              )
            ).rowCount,
            0,
          );
          assert.equal(
            (
              await migration.query(
                "SELECT 1 FROM auth.session WHERE \"userId\"='operator'",
              )
            ).rowCount,
            0,
          );
          await assert.rejects(
            initializeOperator(owner, "outsider"),
            /already completed/,
          );
        },
      );
    } finally {
      owner.release();
    }
  });
});
