import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { initializeOperator } from "../../scripts/lib/initialize-operator.ts";
import {
  exportPrivacyCheckpoint,
  reconcilePrivacyCheckpoint,
} from "../../scripts/lib/privacy-checkpoint.ts";
import { command } from "../../src/database/command.ts";
import { transaction } from "../../src/database/transaction.ts";
import {
  approveRetentionPolicy,
  executePrivacyAction,
  releaseRetentionHold,
  setRetentionHold,
} from "../../src/modules/identity/conservation.ts";
import {
  acceptManager,
  inviteManager,
} from "../../src/modules/identity/manager.ts";
import {
  acceptAdministratorInvitation,
  createMunicipality,
} from "../../src/modules/identity/municipality.ts";
import {
  reviewSharedRetention,
  sharedRetentionContext,
} from "../../src/modules/identity/shared-retention.ts";
import { withDatabase } from "../helpers/postgres.ts";
import { seedUsageRules } from "../helpers/usage-rules-fixture.ts";

const actor = (id: string) => ({
  accountId: id,
  email: `${id}@example.test`,
  sessionId: `s-${id}`,
  mfaVerifiedAt: new Date(),
});
const future = () => new Date(Date.now() + 3600000).toISOString();

test("shared retention requires exact unanimous approvals and retains recovery evidence", {
  timeout: 60000,
}, async () => {
  await withDatabase(async ({ domain, auth, migration, worker }) => {
    for (const id of ["operator", "admin", "privacy", "citizen"])
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
    const scopes: { tenant: string; facility: string }[] = [];
    for (const name of ["A Coruña", "Oleiros"]) {
      const municipality = await createMunicipality(domain, actor("operator"), {
        name,
        timezone: "Europe/Madrid",
        administratorEmail: "admin@example.test",
        invitationExpiresAt: future(),
      });
      await acceptAdministratorInvitation(
        domain,
        actor("admin"),
        municipality.tenantId,
        municipality.invitationId,
      );
      const invitation = await inviteManager(
        domain,
        actor("admin"),
        municipality.tenantId,
        {
          email: "privacy@example.test",
          expiresAt: future(),
          permissions: [
            { operation: "PRIVACY_EXECUTE", unitId: null },
            { operation: "PRIVACY_READ", unitId: null },
          ],
        },
      );
      await acceptManager(
        domain,
        actor("privacy"),
        municipality.tenantId,
        invitation.invitationId,
      );
      const facility = randomUUID();
      await migration.query(
        "INSERT INTO domain.facility(tenant_id,id,name,published_at) VALUES($1,$2,'Pabellón',now())",
        [municipality.tenantId, facility],
      );
      await migration.query(
        "INSERT INTO domain.municipal_profile(tenant_id,account_id) VALUES($1,'citizen')",
        [municipality.tenantId],
      );
      scopes.push({ tenant: municipality.tenantId, facility });
    }
    const [a, b] = scopes as [
      { tenant: string; facility: string },
      { tenant: string; facility: string },
    ];
    async function fixture(
      scope: { tenant: string; facility: string },
      ageDays: number,
      notices = true,
    ) {
      const unit = randomUUID(),
        reservation = randomUUID(),
        event = randomUUID();
      const start = new Date(Date.now() - ageDays * 86400000),
        end = new Date(start.getTime() + 3600000),
        occurred = new Date(start.getTime() - 3600000);
      await transaction(migration, async (connection) => {
        await connection.query(
          "INSERT INTO domain.reservable_unit(tenant_id,id,facility_id,name) VALUES($1,$2,$3,'Pista')",
          [scope.tenant, unit, scope.facility],
        );
        await connection.query(
          "INSERT INTO domain.unit_calendar_version(tenant_id,unit_id,version,minimum_minutes,maximum_minutes,step_minutes,weekly,exceptions,actor_id,reason) VALUES($1,$2,1,60,60,60,'[]','[]','admin','Historical fixture')",
          [scope.tenant, unit],
        );
        await seedUsageRules(connection, scope.tenant, unit, "admin");
        await connection.query(
          "UPDATE domain.reservable_unit SET calendar_version=1,published_at=now() WHERE tenant_id=$1 AND id=$2",
          [scope.tenant, unit],
        );
        await connection.query(
          "INSERT INTO domain.reservation(tenant_id,id,account_id,unit_id,calendar_version,starts_at,ends_at,cancellation_minutes,timezone,created_at) VALUES($1,$2,'citizen',$3,1,$4,$5,1440,'Europe/Madrid',$6)",
          [scope.tenant, reservation, unit, start, end, occurred],
        );
        await connection.query(
          "INSERT INTO domain.occupancy(tenant_id,id,unit_id,reservation_id,period) VALUES($1,$2,$3,$4,tstzrange($5,$6,'[)'))",
          [scope.tenant, randomUUID(), unit, reservation, start, end],
        );
        await connection.query(
          "INSERT INTO domain.reservation_event(tenant_id,id,reservation_id,revision,kind,actor_id,correlation_id,after_state,occurred_at,administrative) SELECT tenant_id,$2,id,1,'CONFIRMADA','citizen',$3,domain.reservation_snapshot(r),$4,false FROM domain.reservation r WHERE tenant_id=$1 AND id=$5",
          [scope.tenant, event, randomUUID(), occurred, reservation],
        );
        if (notices) {
          await connection.query(
            "INSERT INTO domain.reservation_notice(tenant_id,event_id,account_id,created_at) VALUES($1,$2,'citizen',$3)",
            [scope.tenant, event, occurred],
          );
          await connection.query(
            "INSERT INTO domain.reservation_email(tenant_id,event_id,created_at) VALUES($1,$2,$3)",
            [scope.tenant, event, occurred],
          );
        }
      });
      return { tenant: scope.tenant, reservation, event, start, end, occurred };
    }
    const booking = await fixture(a, 60, false);
    const other = await fixture(a, 60, false);
    const agreement = randomUUID(),
      subject = randomUUID(),
      credential = randomUUID();
    await transaction(migration, async (client) => {
      await client.query(
        "INSERT INTO domain.agreement(id,name,timezone,created_by,created_by_tenant) VALUES($1,'Shared','Europe/Madrid','admin',$2)",
        [agreement, a.tenant],
      );
      await client.query(
        "INSERT INTO domain.agreement_version(agreement_id,version,starts_at,ends_at,purpose,legal_basis,responsibilities,retention_policy,eligibility,aggregate_reports,correlation_id,created_by) VALUES($1,1,'2000-01-01','2100-01-01','Purpose','Basis','Responsibilities','Policy','acreditacion_vigente',false,$2,'admin')",
        [agreement, randomUUID()],
      );
      for (const scope of [a, b])
        await client.query(
          "INSERT INTO domain.agreement_participant(agreement_id,version,tenant_id,accreditation_issuer) VALUES($1,1,$2,true)",
          [agreement, scope.tenant],
        );
      await client.query(
        "INSERT INTO domain.agreement_unit(agreement_id,version,tenant_id,unit_id) SELECT $1,1,tenant_id,unit_id FROM domain.reservation WHERE tenant_id=$2 AND id=$3",
        [agreement, a.tenant, booking.reservation],
      );
      await client.query(
        "INSERT INTO domain.agreement_subject(agreement_id,id,account_id) VALUES($1,$2,'citizen')",
        [agreement, subject],
      );
      await client.query(
        "INSERT INTO domain.agreement_credential(id,agreement_id,issued_version,issuer_tenant_id,subject_id,starts_at,ends_at,verification_reference,issued_by,correlation_id) VALUES($1,$2,1,$3,$4,'2000-01-01','2020-01-01','Verification','admin',$5)",
        [credential, agreement, a.tenant, subject, randomUUID()],
      );
      await client.query(
        "INSERT INTO domain.agreement_consumption(agreement_id,tenant_id,reservation_id,subject_id,attribution_version,unit_id,starts_at,ends_at,week_start) SELECT $1,tenant_id,id,$2,1,unit_id,starts_at,ends_at,date_trunc('week',starts_at AT TIME ZONE timezone)::date FROM domain.reservation WHERE tenant_id=$3 AND id=$4",
        [agreement, subject, a.tenant, booking.reservation],
      );
      await client.query(
        "INSERT INTO domain.agreement_consumption_event(id,agreement_id,subject_id,tenant_id,reservation_id,version,action,week_start,starts_at,ends_at,credential_id,actor_id,correlation_id) SELECT $1,agreement_id,subject_id,tenant_id,reservation_id,1,'ATTRIBUTED',week_start,starts_at,ends_at,$2,'admin',$3 FROM domain.agreement_consumption WHERE tenant_id=$4 AND reservation_id=$5",
        [randomUUID(), credential, randomUUID(), a.tenant, booking.reservation],
      );
    });
    const target = {
      ownerTenantId: a.tenant,
      category: "RESERVATIONS" as const,
      targetKey: booking.reservation,
      action: "BLOCK" as const,
      blockDays: 30,
    };
    const read = () =>
      sharedRetentionContext(domain, actor("privacy"), a.tenant, target);
    const approve = async (
      reviewer: string,
      approved = true,
      digest?: string,
    ) =>
      reviewSharedRetention(
        domain,
        actor("privacy"),
        reviewer,
        {
          ...target,
          digest: digest ?? (await read()).digest,
          approved,
          authorizationReference: "Controller authorization",
          reason: "Approved test decision",
        },
        randomUUID(),
      );
    const execute = () =>
      executePrivacyAction(
        domain,
        actor("privacy"),
        a.tenant,
        {
          category: target.category,
          targetKey: target.targetKey,
          action: target.action,
          blockDays: target.blockDays,
          authorizationReference: "Individual action",
          reason: "Approved retirement",
        },
        randomUUID(),
      );
    assert.equal((await execute()).reason, "SHARED_CONTROLLER_REVIEW");
    await assert.rejects(
      sharedRetentionContext(domain, actor("admin"), a.tenant, target),
      { code: "FORBIDDEN" },
    );
    await assert.rejects(
      sharedRetentionContext(
        domain,
        { ...actor("privacy"), mfaVerifiedAt: new Date(Date.now() - 3600000) },
        a.tenant,
        target,
      ),
      { code: "REAUTHENTICATION_REQUIRED" },
    );
    const context = await read();
    assert.equal(context.controllers.length, 2);
    assert.equal(Object.hasOwn(context, "content"), false);
    await approve(a.tenant);
    assert.equal((await execute()).status, "CONFLICT");
    await approve(b.tenant);
    await approve(b.tenant, false);
    assert.equal((await execute()).status, "CONFLICT");
    await approve(b.tenant);
    assert.equal(
      (
        await executePrivacyAction(
          domain,
          actor("privacy"),
          a.tenant,
          {
            category: target.category,
            targetKey: target.targetKey,
            action: target.action,
            blockDays: 31,
            authorizationReference: "Other period",
            reason: "Must be reviewed",
          },
          randomUUID(),
        )
      ).status,
      "CONFLICT",
    );
    await approveRetentionPolicy(
      domain,
      actor("privacy"),
      a.tenant,
      {
        category: "RESERVATIONS",
        retentionDays: 90,
        action: "BLOCK",
        blockDays: 30,
        purpose: "Retention",
        controllerReference: "Controller",
        approvalReference: "New policy",
        reason: "Policy version",
      },
      randomUUID(),
    );
    assert.notEqual((await read()).digest, context.digest);
    await assert.rejects(approve(a.tenant, true, context.digest), {
      code: "STALE_VERSION",
    });
    assert.equal((await execute()).status, "CONFLICT");
    await approve(a.tenant);
    await approve(b.tenant);
    const hold = await setRetentionHold(
      domain,
      actor("privacy"),
      b.tenant,
      {
        category: "RESERVATIONS",
        targetKey: booking.reservation,
        authorizationReference: "Other controller hold",
        reason: "Retain evidence",
      },
      randomUUID(),
    );
    assert.equal((await execute()).status, "CONFLICT");
    await releaseRetentionHold(
      domain,
      actor("privacy"),
      b.tenant,
      hold.holdId,
      "Release authority",
      "Matter closed",
      randomUUID(),
    );
    const applied = await execute();
    assert.equal(applied.status, "APPLIED");
    const archive = (
      await migration.query(
        "SELECT * FROM domain.retention_archive WHERE event_id=$1",
        [applied.eventId],
      )
    ).rows[0];
    assert.equal(archive.payload.consumption.length, 1);
    assert.equal(archive.payload.consumptionEvents.length, 1);
    assert.deepEqual(
      new Set(archive.payload.sharedControllers),
      new Set([a.tenant, b.tenant]),
    );
    assert.equal(
      (
        await migration.query(
          "SELECT count(*)::int n FROM domain.reservation WHERE id=$1",
          [other.reservation],
        )
      ).rows[0].n,
      1,
    );
    for (const pool of [domain, worker, auth])
      await assert.rejects(
        pool.query(
          "SELECT domain.retention_apply($1,'RESERVATIONS',$2,now(),'ERASE',NULL,true)",
          [a.tenant, other.reservation],
        ),
        { code: "42501" },
      );
    const connection = await migration.connect();
    try {
      const checkpoint = await exportPrivacyCheckpoint(connection);
      assert.equal(
        checkpoint.actions[0]?.sharedAuthorization?.reviews.length,
        2,
      );
      // Simulate pre-action data returning from a closed backup, with no approval rows.
      await transaction(migration, async (client) => {
        for (const [table, value] of [
          ["reservation", [archive.payload.reservation]],
          ["reservation_event", archive.payload.events],
          ["occupancy", archive.payload.occupancy],
          ["agreement_consumption", archive.payload.consumption],
          ["agreement_consumption_event", archive.payload.consumptionEvents],
        ] as const)
          await client.query(
            `INSERT INTO domain.${table} SELECT * FROM jsonb_populate_recordset(NULL::domain.${table},$1::jsonb)`,
            [JSON.stringify(value)],
          );
        await client.query("DELETE FROM domain.shared_retention_review");
        await client.query(
          "UPDATE domain.retention_control SET restore_review_required=true WHERE id",
        );
      });
      const replay = await reconcilePrivacyCheckpoint(
        connection,
        checkpoint,
        "a".repeat(64),
        "Verified external checkpoint",
      );
      assert.equal(replay.replayed, 1);
      assert.equal(replay.reopeningAuthorized, false);
      assert.deepEqual(
        (await exportPrivacyCheckpoint(connection)).actions,
        checkpoint.actions,
      );
    } finally {
      connection.release();
    }
    await migration.query(
      "UPDATE domain.retention_control SET restore_review_required=false WHERE id",
    );
    // All historical issuers may now authorize the expired, unreferenced credential.
    const credentialTarget = {
      ownerTenantId: a.tenant,
      category: "ACCREDITATIONS" as const,
      targetKey: credential,
      action: "ERASE" as const,
    };
    const credentialContext = await sharedRetentionContext(
      domain,
      actor("privacy"),
      a.tenant,
      credentialTarget,
    );
    for (const scope of [a, b])
      await reviewSharedRetention(
        domain,
        actor("privacy"),
        scope.tenant,
        {
          ...credentialTarget,
          digest: credentialContext.digest,
          approved: true,
          authorizationReference: "Credential retirement",
          reason: "No retained references",
        },
        randomUUID(),
      );
    assert.equal(
      (
        await executePrivacyAction(
          domain,
          actor("privacy"),
          a.tenant,
          {
            category: credentialTarget.category,
            targetKey: credentialTarget.targetKey,
            action: credentialTarget.action,
            authorizationReference: "Credential action",
            reason: "Expired evidence",
          },
          randomUUID(),
        )
      ).status,
      "APPLIED",
    );
    const archiveHold = await setRetentionHold(
      domain,
      actor("privacy"),
      b.tenant,
      {
        category: "RESERVATIONS",
        targetKey: booking.reservation,
        authorizationReference: "Retain shared archive",
        reason: "Pending claim",
      },
      randomUUID(),
    );
    await migration.query(
      "UPDATE domain.retention_archive SET destroy_after=now()-interval '1 day' WHERE id=$1",
      [archive.id],
    );
    const batch = () =>
      command(
        worker,
        undefined,
        async (client) =>
          (await client.query("SELECT domain.process_retention_batch(1) data"))
            .rows[0].data,
      );
    assert.equal((await batch()).processed, 0);
    await releaseRetentionHold(
      domain,
      actor("privacy"),
      b.tenant,
      archiveHold.holdId,
      "Archive release",
      "Claim resolved",
      randomUUID(),
    );
    assert.equal((await batch()).processed, 1);
  });
});
