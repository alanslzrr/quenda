import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Pool } from "pg";
import { initializeOperator } from "../../scripts/lib/initialize-operator.ts";
import { transaction } from "../../src/database/transaction.ts";
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
  acceptGlobalPrivacy,
  inviteGlobalPrivacy,
  revokeGlobalPrivacy,
} from "../../src/modules/identity/privacy-permissions.ts";
import { withDatabase } from "../helpers/postgres.ts";

const actor = (id: string) => ({
  accountId: id,
  email: `${id}@example.test`,
  sessionId: `s-${id}`,
  mfaVerifiedAt: new Date(),
});
const future = () => new Date(Date.now() + 3600000).toISOString();
const cutoff = () => new Date(Date.now() + 2000).toISOString();
async function apply(
  pool: Pool,
  tenant: string | null,
  category: string,
  key: string,
  before = cutoff(),
) {
  return transaction(
    pool,
    async (client) =>
      (
        await client.query(
          "SELECT domain.retention_municipal_action($1,$2,$3,$4) AS result",
          [tenant, category, key, before],
        )
      ).rows[0].result,
  );
}

test("municipal retention respects active responsibility, dependencies, scope and legal holds", {
  timeout: 60000,
}, async (t) => {
  await withDatabase(async ({ domain, auth, migration, worker }) => {
    for (const id of [
      "operator",
      "admin",
      "idle",
      "manager",
      "privacy",
      "credential-holder",
      "rollback",
    ])
      await auth.query(
        'INSERT INTO auth."user"(id,name,email,"emailVerified","updatedAt","twoFactorEnabled") VALUES($1,$1,$2,true,now(),true)',
        [id, `${id}@example.test`],
      );
    const client = await migration.connect();
    try {
      await initializeOperator(client, "operator");
    } finally {
      client.release();
    }
    const tenants: string[] = [];
    for (const name of ["Municipality A", "Municipality B"]) {
      const municipality = await createMunicipality(domain, actor("operator"), {
        name,
        timezone: "Europe/Madrid",
        administratorId: "admin",
        invitationExpiresAt: future(),
      });
      await acceptAdministratorInvitation(
        domain,
        actor("admin"),
        municipality.tenantId,
        municipality.invitationId,
      );
      tenants.push(municipality.tenantId);
    }
    const [first, second] = tenants as [string, string];
    await t.test(
      "internal destructive handlers are unavailable to application and worker roles",
      async () => {
        for (const pool of [domain, worker, auth]) {
          await assert.rejects(
            pool.query(
              "SELECT domain.retention_municipal_action($1,'MUNICIPAL_PROFILE','idle',now())",
              [first],
            ),
            { code: "42501" },
          );
          await assert.rejects(
            pool.query(
              "SELECT * FROM domain.retention_municipal_candidates($1,'AUTHORITY',now(),10)",
              [first],
            ),
            { code: "42501" },
          );
        }
      },
    );
    await t.test(
      "an eligible empty internal profile is removed only in the chosen municipality",
      async () => {
        for (const tenant of tenants)
          await migration.query(
            "INSERT INTO domain.municipal_profile(tenant_id,account_id,created_at) VALUES($1,'idle','2020-01-01')",
            [tenant],
          );
        const candidates = (
          await migration.query(
            "SELECT * FROM domain.retention_municipal_candidates($1,'MUNICIPAL_PROFILE','2021-01-01',10)",
            [first],
          )
        ).rows;
        assert.ok(candidates.some((r) => r.target_key === "idle"));
        const result = await apply(
          migration,
          first,
          "MUNICIPAL_PROFILE",
          "idle",
          "2021-01-01",
        );
        assert.equal(result.status, "APPLIED");
        assert.equal(result.payload.municipalProfile.account_id, "idle");
        assert.equal(result.payload.municipalProfile.tenant_id, first);
        assert.equal(
          (
            await migration.query(
              "SELECT * FROM domain.municipal_profile WHERE account_id='idle'",
            )
          ).rowCount,
          1,
        );
        assert.equal(
          (await migration.query("SELECT * FROM auth.\"user\" WHERE id='idle'"))
            .rowCount,
          1,
        );
        assert.equal(
          (await apply(migration, first, "MUNICIPAL_PROFILE", "idle")).status,
          "ABSENT",
        );
      },
    );
    await t.test(
      "legal holds stop removal and a transactional rollback restores the profile",
      async () => {
        const hold = randomUUID();
        await migration.query(
          "INSERT INTO domain.retention_hold(id,tenant_id,category,subject_id,authority_reference,reason,created_by) VALUES($1,$2,'MUNICIPAL_PROFILE','idle','Reference','Reason','admin')",
          [hold, second],
        );
        assert.equal(
          (await apply(migration, second, "MUNICIPAL_PROFILE", "idle")).reason,
          "LEGAL_HOLD",
        );
        await migration.query(
          "UPDATE domain.retention_hold SET released_at=now() WHERE id=$1",
          [hold],
        );
        await assert.rejects(
          transaction(migration, async (client) => {
            assert.equal(
              (
                await client.query(
                  "SELECT domain.retention_municipal_action($1,'MUNICIPAL_PROFILE','idle',now()) AS result",
                  [second],
                )
              ).rows[0].result.status,
              "APPLIED",
            );
            throw new Error("caller failed before archive persistence");
          }),
          /caller failed/,
        );
        assert.equal(
          (
            await migration.query(
              "SELECT * FROM domain.municipal_profile WHERE tenant_id=$1 AND account_id='idle'",
              [second],
            )
          ).rowCount,
          1,
        );
      },
    );
    await t.test(
      "active roles and profiles supporting retained roles cannot be removed",
      async () => {
        assert.equal(
          (await apply(migration, first, "AUTHORITY", "admin")).reason,
          "ACTIVE_AUTHORITY",
        );
        assert.equal(
          (await apply(migration, first, "MUNICIPAL_PROFILE", "admin")).reason,
          "RETAINED_SERVICE_DEPENDENCIES",
        );
        assert.equal(
          (await apply(migration, null, "AUTHORITY", "operator")).reason,
          "ACTIVE_AUTHORITY",
        );
      },
    );
    await t.test(
      "revoked manager history is captured atomically without touching another municipality",
      async () => {
        const grants: string[] = [];
        for (const tenant of tenants) {
          const invitation = await inviteManager(
            domain,
            actor("admin"),
            tenant,
            {
              accountId: "manager",
              expiresAt: future(),
              permissions: [{ operation: "RESERVATION_READ", unitId: null }],
            },
          );
          grants.push(invitation.invitationId);
          await acceptManager(
            domain,
            actor("manager"),
            tenant,
            invitation.invitationId,
          );
        }
        await revokeManager(
          domain,
          actor("admin"),
          first,
          grants[0] as string,
          "Contract ended",
        );
        const result = await apply(migration, first, "AUTHORITY", "manager");
        assert.equal(result.status, "APPLIED");
        assert.equal(result.payload.managerInvitations.length, 1);
        assert.equal(result.payload.managerGrants.length, 1);
        assert.equal(result.payload.managerPermissions.length, 1);
        assert.ok(result.payload.managerEvents.length >= 3);
        assert.equal(
          (
            await migration.query(
              "SELECT * FROM domain.manager_grant WHERE tenant_id=$1 AND account_id='manager'",
              [first],
            )
          ).rowCount,
          0,
        );
        assert.equal(
          (
            await migration.query(
              "SELECT * FROM domain.manager_grant WHERE tenant_id=$1 AND account_id='manager'",
              [second],
            )
          ).rowCount,
          1,
        );
        assert.equal(
          (await apply(migration, first, "MUNICIPAL_PROFILE", "manager"))
            .status,
          "APPLIED",
        );
      },
    );
    await t.test(
      "global privacy grants are not erased while active and retained histories are scoped globally",
      async () => {
        const invitation = await inviteGlobalPrivacy(
          domain,
          actor("operator"),
          {
            accountId: "privacy",
            permissions: ["PRIVACY_READ"],
            expiresAt: future(),
            reason: "Fixture",
          },
        );
        await acceptGlobalPrivacy(
          domain,
          actor("privacy"),
          invitation.invitationId,
        );
        assert.equal(
          (await apply(migration, null, "AUTHORITY", "privacy")).reason,
          "ACTIVE_AUTHORITY",
        );
        await revokeGlobalPrivacy(
          domain,
          actor("operator"),
          invitation.invitationId,
          "Ended",
        );
        const result = await apply(migration, null, "AUTHORITY", "privacy");
        assert.equal(result.status, "APPLIED");
        assert.equal(result.payload.privacyInvitations.length, 1);
        assert.equal(result.payload.privacyEvents.length, 3);
      },
    );
    await t.test(
      "referenced authority histories return a conflict without partial deletion",
      async () => {
        const invitation = await inviteManager(domain, actor("admin"), first, {
          accountId: "rollback",
          expiresAt: future(),
          permissions: [{ operation: "RESERVATION_READ", unitId: null }],
        });
        await acceptManager(
          domain,
          actor("rollback"),
          first,
          invitation.invitationId,
        );
        await revokeManager(
          domain,
          actor("admin"),
          first,
          invitation.invitationId,
          "Ended",
        );
        const dependent = await inviteManager(domain, actor("admin"), first, {
          accountId: "privacy",
          expiresAt: future(),
          permissions: [{ operation: "REPORT_READ", unitId: null }],
        });
        await migration.query(
          "UPDATE domain.manager_invitation SET replaces_invitation_id=$1 WHERE tenant_id=$2 AND id=$3",
          [invitation.invitationId, first, dependent.invitationId],
        );
        const before = (
          await migration.query(
            "SELECT count(*)::int AS n FROM domain.manager_event WHERE tenant_id=$1 AND invitation_id=$2",
            [first, invitation.invitationId],
          )
        ).rows[0].n;
        const result = await apply(migration, first, "AUTHORITY", "rollback");
        assert.equal(result.status, "CONFLICT");
        assert.equal(result.reason, "RETAINED_REFERENCE");
        assert.equal(
          (
            await migration.query(
              "SELECT count(*)::int AS n FROM domain.manager_event WHERE tenant_id=$1 AND invitation_id=$2",
              [first, invitation.invitationId],
            )
          ).rows[0].n,
          before,
        );
        assert.equal(
          (
            await migration.query(
              "SELECT * FROM domain.manager_permission WHERE tenant_id=$1 AND invitation_id=$2",
              [first, invitation.invitationId],
            )
          ).rowCount,
          1,
        );
      },
    );
    await t.test(
      "unilaterally removing a shared accreditation is rejected, even after expiry",
      async () => {
        const agreement = randomUUID(),
          subject = randomUUID(),
          credential = randomUUID();
        await transaction(migration, async (client) => {
          await client.query(
            "INSERT INTO domain.agreement(id,name,timezone,created_by,created_by_tenant) VALUES($1,'Shared programme','Europe/Madrid','admin',$2)",
            [agreement, first],
          );
          await client.query(
            "INSERT INTO domain.agreement_version(agreement_id,version,starts_at,ends_at,purpose,legal_basis,responsibilities,retention_policy,eligibility,aggregate_reports,correlation_id,created_by) VALUES($1,1,'2019-01-01','2021-01-01','Fixture','Fixture','Fixture','Fixture','acreditacion_vigente',false,$2,'admin')",
            [agreement, randomUUID()],
          );
          for (const tenant of tenants)
            await client.query(
              "INSERT INTO domain.agreement_participant(agreement_id,version,tenant_id,accreditation_issuer) VALUES($1,1,$2,true)",
              [agreement, tenant],
            );
          await client.query(
            "INSERT INTO domain.agreement_subject(agreement_id,id,account_id) VALUES($1,$2,'credential-holder')",
            [agreement, subject],
          );
          await client.query(
            "INSERT INTO domain.agreement_credential(id,agreement_id,issued_version,issuer_tenant_id,subject_id,starts_at,ends_at,verification_reference,issued_by,correlation_id) VALUES($1,$2,1,$3,$4,'2019-01-01','2020-01-01','Verification','admin',$5)",
            [credential, agreement, first, subject, randomUUID()],
          );
        });
        assert.equal(
          (await apply(migration, first, "ACCREDITATIONS", credential)).reason,
          "SHARED_CONTROLLER_REVIEW",
        );
        assert.equal(
          (await apply(migration, second, "ACCREDITATIONS", credential)).status,
          "ABSENT",
        );
        assert.equal(
          (
            await migration.query(
              "SELECT * FROM domain.agreement_credential WHERE id=$1",
              [credential],
            )
          ).rowCount,
          1,
        );
      },
    );
    await t.test(
      "privacy access audits expire independently from active authority and remain scoped",
      async () => {
        const id = randomUUID(),
          hold = randomUUID();
        await migration.query(
          "INSERT INTO domain.personal_data_access_event(id,actor_id,subject_id,scope_tenant_id,access_mode,reason,authorization_reference,record_count,occurred_at) VALUES($1,'admin','idle',$2,'MUNICIPAL','Approved response','External authority',2,'2020-01-01')",
          [id, first],
        );
        const candidates = (
          await migration.query(
            "SELECT * FROM domain.retention_municipal_candidates($1,'AUTHORITY','2021-01-01',100)",
            [first],
          )
        ).rows;
        assert.ok(candidates.some((r) => r.target_key === `access:${id}`));
        assert.equal(
          (await apply(migration, second, "AUTHORITY", `access:${id}`)).status,
          "ABSENT",
        );
        assert.equal(
          (await apply(migration, null, "AUTHORITY", `access:${id}`)).status,
          "ABSENT",
        );
        await migration.query(
          "INSERT INTO domain.retention_hold(id,tenant_id,category,subject_id,authority_reference,reason,created_by) VALUES($1,$2,'AUTHORITY','admin','Authority','Preserve actor evidence','admin')",
          [hold, first],
        );
        assert.equal(
          (await apply(migration, first, "AUTHORITY", `access:${id}`)).reason,
          "LEGAL_HOLD",
        );
        await migration.query(
          "UPDATE domain.retention_hold SET released_at=now() WHERE id=$1",
          [hold],
        );
        const result = await apply(
          migration,
          first,
          "AUTHORITY",
          `access:${id}`,
        );
        assert.equal(result.status, "APPLIED");
        assert.equal(result.payload.personalDataAccessEvent.id, id);
        assert.equal(
          (
            await migration.query(
              "SELECT * FROM domain.municipal_administrator WHERE tenant_id=$1 AND account_id='admin' AND revoked_at IS NULL",
              [first],
            )
          ).rowCount,
          1,
        );
      },
    );
    await t.test(
      "untrusted denied target municipality never defines authority over a security audit",
      async () => {
        const id = randomUUID();
        await migration.query(
          "INSERT INTO domain.access_denial(request_id,actor_id,requested_tenant_id,operation,outcome,occurred_at) VALUES($1,'admin',$2,'fixture','FORBIDDEN','2020-01-01')",
          [id, first],
        );
        const municipalCandidates = (
          await migration.query(
            "SELECT * FROM domain.retention_municipal_candidates($1,'AUTHORITY','2021-01-01',100)",
            [first],
          )
        ).rows;
        assert.equal(
          municipalCandidates.some((r) => r.target_key === `denial:${id}`),
          false,
        );
        assert.equal(
          (await apply(migration, first, "AUTHORITY", `denial:${id}`)).reason,
          "GLOBAL_SECURITY_SCOPE_REQUIRED",
        );
        const result = await apply(
          migration,
          null,
          "AUTHORITY",
          `denial:${id}`,
        );
        assert.equal(result.status, "APPLIED");
        assert.equal(result.payload.accessDenial.requested_tenant_id, first);
      },
    );
    await t.test(
      "recent conflicts do not starve later eligible candidates",
      async () => {
        const policy = randomUUID();
        await migration.query(
          "INSERT INTO domain.retention_policy(id,tenant_id,category,retention_days,action,purpose,controller_reference,approval_reference,reason,approved_by) VALUES($1,$2,'MUNICIPAL_PROFILE',1,'ERASE','Fixture','Controller','Approval','Fixture','admin')",
          [policy, second],
        );
        await migration.query(
          "INSERT INTO domain.retention_conflict(policy_id,target_key,reason) VALUES($1,'idle','LEGAL_HOLD')",
          [policy],
        );
        const candidates = (
          await migration.query(
            "SELECT * FROM domain.retention_municipal_candidates($1,'MUNICIPAL_PROFILE',$2,100)",
            [second, cutoff()],
          )
        ).rows;
        assert.equal(
          candidates.some((r) => r.target_key === "idle"),
          false,
        );
      },
    );
  });
});
