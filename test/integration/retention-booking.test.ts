import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { initializeOperator } from "../../scripts/lib/initialize-operator.ts";
import { command } from "../../src/database/command.ts";
import { transaction } from "../../src/database/transaction.ts";
import { listOwnNotices } from "../../src/modules/communications/index.ts";
import {
  approveRetentionPolicy,
  executePrivacyAction,
  revokeRetentionPolicy,
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
import { exportOwnPersonalData } from "../../src/modules/identity/personal-data.ts";
import { listOwnReservations } from "../../src/modules/reservations/index.ts";
import { withDatabase } from "../helpers/postgres.ts";
import { seedUsageRules } from "../helpers/usage-rules-fixture.ts";

const actor = (id: string) => ({
  accountId: id,
  email: `${id}@example.test`,
  sessionId: `s-${id}`,
  mfaVerifiedAt: new Date(),
});
const future = () => new Date(Date.now() + 3600000).toISOString();

test("approved retention executes scoped booking and communication policies without partial removal", {
  timeout: 60000,
}, async (t) => {
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
        administratorId: "admin",
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
          accountId: "privacy",
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
    const batch = (limit = 100) =>
      command(
        worker,
        undefined,
        async (connection) =>
          (
            await connection.query(
              "SELECT domain.process_retention_batch($1) AS result",
              [limit],
            )
          ).rows[0].result,
      );
    const clearPolicies = () =>
      migration.query(
        "UPDATE domain.retention_policy SET revoked_at=now() WHERE revoked_at IS NULL AND superseded_at IS NULL",
      );
    async function policy(
      tenant: string,
      category: "COMMUNICATIONS" | "RESERVATIONS",
      days = 10,
      action: "ERASE" | "BLOCK" = "ERASE",
    ) {
      return approveRetentionPolicy(
        domain,
        actor("privacy"),
        tenant,
        {
          category,
          retentionDays: days,
          action,
          ...(action === "BLOCK" ? { blockDays: 30 } : {}),
          purpose: "Approved synthetic test purpose",
          controllerReference: `Municipality ${tenant}`,
          approvalReference: "Approved test policy reference",
          reason: "Test fixture approval",
        },
        randomUUID(),
      );
    }
    const count = async (
      table: string,
      tenant: string,
      key: string,
      column = "event_id",
    ) =>
      (
        await migration.query(
          `SELECT count(*)::int AS n FROM domain.${table} WHERE tenant_id=$1 AND ${column}=$2`,
          [tenant, key],
        )
      ).rows[0].n;
    await t.test("no approved policy means no automatic erasure", async () => {
      const item = await fixture(a, 100);
      assert.deepEqual(await batch(), {
        processed: 0,
        conflicts: 0,
        examined: 0,
      });
      assert.equal(await count("reservation_notice", a.tenant, item.event), 1);
      assert.equal(
        await count("reservation", a.tenant, item.reservation, "id"),
        1,
      );
    });
    await t.test(
      "the same category follows each municipality's own approved period",
      async () => {
        await clearPolicies();
        const first = await fixture(a, 15),
          second = await fixture(b, 15);
        await policy(a.tenant, "COMMUNICATIONS", 10);
        await policy(b.tenant, "COMMUNICATIONS", 20);
        await batch();
        assert.equal(
          await count("reservation_notice", a.tenant, first.event),
          0,
        );
        assert.equal(
          await count("reservation_notice", b.tenant, second.event),
          1,
        );
        assert.equal(
          await count("reservation", a.tenant, first.reservation, "id"),
          1,
        );
        assert.equal(
          await count("reservation_event", a.tenant, first.event, "id"),
          1,
        );
        const applied = (
          await migration.query(
            "SELECT * FROM domain.retention_event WHERE operation='RETENTION_APPLIED' AND target_key=$1",
            [first.event],
          )
        ).rows;
        assert.equal(applied.length, 1);
        assert.equal(
          applied[0].authorization_reference,
          "Approved test policy reference",
        );
      },
    );
    await t.test(
      "blocking removes ordinary visibility and stores evidence outside all runtime roles",
      async () => {
        await clearPolicies();
        const item = await fixture(a, 40);
        await policy(a.tenant, "COMMUNICATIONS", 10, "BLOCK");
        await policy(a.tenant, "RESERVATIONS", 10, "BLOCK");
        await batch();
        // Conflicting candidates are skipped for one hour; a second pass is not
        // required when communication policy was approved before booking policy.
        assert.equal(
          await count("reservation", a.tenant, item.reservation, "id"),
          0,
        );
        assert.equal(
          await count(
            "occupancy",
            a.tenant,
            item.reservation,
            "reservation_id",
          ),
          0,
        );
        assert.equal(
          (await listOwnReservations(domain, actor("citizen"))).items.some(
            (r) => r.id === item.reservation,
          ),
          false,
        );
        assert.equal(
          (await listOwnNotices(domain, actor("citizen"))).items.some(
            (r) => r.eventId === item.event,
          ),
          false,
        );
        const archive = (
          await migration.query(
            "SELECT * FROM domain.retention_archive WHERE tenant_id=$1 AND target_key=$2",
            [a.tenant, item.reservation],
          )
        ).rows[0];
        assert.ok(archive);
        assert.equal(archive.payload.reservation.account_id, "citizen");
        assert.equal(archive.payload.events.length, 1);
        const communicationArchive = (
          await migration.query(
            "SELECT payload FROM domain.retention_archive WHERE tenant_id=$1 AND target_key=$2",
            [a.tenant, item.event],
          )
        ).rows[0].payload;
        assert.equal(
          communicationArchive.eventContent.reservationId,
          item.reservation,
        );
        assert.equal(
          communicationArchive.eventContent.after.unitId,
          archive.payload.reservation.unit_id,
        );
        const download = await exportOwnPersonalData(
          domain,
          actor("citizen"),
          randomUUID(),
        );
        assert.ok(
          download.completeness.restrictedCategories.some(
            (r) => r.tenantId === a.tenant && r.category === "RESERVATIONS",
          ),
        );
        assert.equal(
          download.records.some(
            (r) =>
              r.type === "reservation" &&
              r.data.reservationId === item.reservation,
          ),
          false,
        );
        for (const pool of [domain, auth, worker])
          await assert.rejects(
            pool.query("SELECT * FROM domain.retention_archive"),
            { code: "42501" },
          );
      },
    );
    await t.test(
      "holds, pending communications and live delivery leases preserve their dependent rows",
      async () => {
        await clearPolicies();
        const held = await fixture(a, 40),
          leased = await fixture(a, 40),
          retained = await fixture(a, 40);
        await setRetentionHold(
          domain,
          actor("privacy"),
          a.tenant,
          {
            category: "COMMUNICATIONS",
            targetKey: held.event,
            authorizationReference: "Legal hold",
            reason: "Preserve evidence",
          },
          randomUUID(),
        );
        const token = randomUUID();
        await migration.query(
          "UPDATE domain.reservation_email SET attempts=1,lease_token=$1,lease_until=now()+interval '1 hour' WHERE tenant_id=$2 AND event_id=$3",
          [token, a.tenant, leased.event],
        );
        await migration.query(
          "INSERT INTO domain.reservation_email_attempt(tenant_id,event_id,attempt,token,started_at) VALUES($1,$2,1,$3,$4)",
          [a.tenant, leased.event, token, leased.occurred],
        );
        await policy(a.tenant, "RESERVATIONS", 10);
        const result = await batch();
        assert.ok(result.conflicts > 0);
        assert.equal(
          await count("reservation", a.tenant, retained.reservation, "id"),
          1,
        );
        await policy(a.tenant, "COMMUNICATIONS", 10);
        await batch();
        assert.equal(
          await count("reservation_notice", a.tenant, held.event),
          1,
        );
        assert.equal(
          await count("reservation_email", a.tenant, leased.event),
          1,
        );
        assert.equal(
          await count("reservation_email_attempt", a.tenant, leased.event),
          1,
        );
        const conflicts = (
          await migration.query(
            "SELECT reason FROM domain.retention_conflict WHERE target_key=ANY($1::text[])",
            [[held.event, leased.event]],
          )
        ).rows.map((r) => r.reason);
        assert.ok(conflicts.includes("LEGAL_HOLD"));
        assert.ok(conflicts.includes("EMAIL_IN_FLIGHT"));
      },
    );
    await t.test(
      "future and ongoing reservations are never candidates and direct rights erasure cannot bypass that protection",
      async () => {
        await clearPolicies();
        const futureItem = await fixture(a, -2, false);
        const ongoingItem = await fixture(a, 1 / 48, false);
        for (const item of [futureItem, ongoingItem]) {
          await policy(a.tenant, "RESERVATIONS", 1);
          await batch();
          assert.equal(
            await count("reservation", a.tenant, item.reservation, "id"),
            1,
          );
          const result = await executePrivacyAction(
            domain,
            actor("privacy"),
            a.tenant,
            {
              category: "RESERVATIONS",
              targetKey: item.reservation,
              action: "ERASE",
              authorizationReference: "Request authorization",
              reason: "Approved request",
            },
            randomUUID(),
          );
          assert.equal(result.status, "CONFLICT");
          assert.equal(
            await count("reservation", a.tenant, item.reservation, "id"),
            1,
          );
          assert.equal(
            await count(
              "occupancy",
              a.tenant,
              item.reservation,
              "reservation_id",
            ),
            1,
          );
        }
      },
    );
    await t.test(
      "unexpired idempotency snapshots protect reservations and expired copies are removed with them",
      async () => {
        await clearPolicies();
        const item = await fixture(b, 60, false),
          key = randomUUID();
        await migration.query(
          "INSERT INTO domain.idempotent_command(tenant_id,actor_id,operation,key,fingerprint,result,created_at,expires_at) VALUES($1,'citizen','reservation.create',$2,$3,$4,now()-interval '2 days',now()+interval '1 hour')",
          [
            b.tenant,
            key,
            "a".repeat(64),
            {
              id: item.reservation,
              tenantId: b.tenant,
              startsAt: item.start.toISOString(),
            },
          ],
        );
        const approval = await policy(b.tenant, "RESERVATIONS", 10);
        await batch();
        assert.equal(
          await count("reservation", b.tenant, item.reservation, "id"),
          1,
        );
        assert.equal(
          (
            await migration.query(
              "SELECT reason FROM domain.retention_conflict WHERE policy_id=$1 AND target_key=$2",
              [approval.policyId, item.reservation],
            )
          ).rows[0].reason,
          "IDEMPOTENCY_WINDOW",
        );
        await migration.query(
          "UPDATE domain.idempotent_command SET expires_at=now()-interval '1 day' WHERE tenant_id=$1 AND key=$2",
          [b.tenant, key],
        );
        // A conflict that has stood for days is not examined again every hour.
        await migration.query(
          "UPDATE domain.retention_conflict SET first_seen_at=now()-interval '3 days',last_seen_at=now()-interval '2 hours' WHERE policy_id=$1 AND target_key=$2",
          [approval.policyId, item.reservation],
        );
        await batch();
        assert.equal(
          await count("reservation", b.tenant, item.reservation, "id"),
          1,
        );
        await migration.query(
          "UPDATE domain.retention_conflict SET first_seen_at=now()-interval '150 minutes' WHERE policy_id=$1 AND target_key=$2",
          [approval.policyId, item.reservation],
        );
        await batch();
        assert.equal(
          await count("reservation", b.tenant, item.reservation, "id"),
          0,
        );
        assert.equal(
          (
            await migration.query(
              "SELECT * FROM domain.idempotent_command WHERE tenant_id=$1 AND key=$2",
              [b.tenant, key],
            )
          ).rowCount,
          0,
        );
      },
    );
    await t.test(
      "revoked policies stop subsequent automatic operations",
      async () => {
        await clearPolicies();
        const item = await fixture(b, 60);
        const approved = await policy(b.tenant, "COMMUNICATIONS", 10);
        await revokeRetentionPolicy(
          domain,
          actor("privacy"),
          b.tenant,
          approved.policyId,
          "Controller revoked policy",
          randomUUID(),
        );
        await batch();
        assert.equal(
          await count("reservation_notice", b.tenant, item.event),
          1,
        );
      },
    );
    await t.test(
      "concurrent workers and retries record an operation only once",
      async () => {
        await clearPolicies();
        const item = await fixture(b, 60);
        await policy(b.tenant, "COMMUNICATIONS", 10);
        await Promise.all(Array.from({ length: 3 }, () => batch()));
        await batch();
        assert.equal(
          await count("reservation_notice", b.tenant, item.event),
          0,
        );
        assert.equal(
          (
            await migration.query(
              "SELECT * FROM domain.retention_event WHERE operation='RETENTION_APPLIED' AND target_key=$1",
              [item.event],
            )
          ).rowCount,
          1,
        );
      },
    );
    await t.test(
      "audit insertion failure rolls back notices, mail, archive and every partial effect",
      async () => {
        await clearPolicies();
        const item = await fixture(b, 60);
        await policy(b.tenant, "COMMUNICATIONS", 10, "BLOCK");
        await migration.query(
          "CREATE FUNCTION domain.reject_retention_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.operation='RETENTION_APPLIED' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_retention_test BEFORE INSERT ON domain.retention_event FOR EACH ROW EXECUTE FUNCTION domain.reject_retention_test()",
        );
        try {
          await assert.rejects(batch(), /synthetic audit failure/);
          assert.equal(
            await count("reservation_notice", b.tenant, item.event),
            1,
          );
          assert.equal(
            await count("reservation_email", b.tenant, item.event),
            1,
          );
          assert.equal(
            (
              await migration.query(
                "SELECT * FROM domain.retention_archive WHERE target_key=$1",
                [item.event],
              )
            ).rowCount,
            0,
          );
          assert.equal(
            (
              await migration.query(
                "SELECT * FROM domain.retention_event WHERE operation='RETENTION_APPLIED' AND target_key=$1",
                [item.event],
              )
            ).rowCount,
            0,
          );
        } finally {
          await migration.query(
            "DROP TRIGGER reject_retention_test ON domain.retention_event; DROP FUNCTION domain.reject_retention_test()",
          );
        }
      },
    );
    await t.test(
      "old held archives do not starve later archives eligible for destruction",
      async () => {
        await clearPolicies();
        const ids: string[] = [];
        for (const [index, key] of ["held-oldest", "due-later"].entries()) {
          const event = (
            await migration.query(
              "INSERT INTO domain.retention_event(operation,tenant_id,category,target_key,subject_id,action) VALUES('RETENTION_APPLIED',$1,'COMMUNICATIONS',$2,'citizen','BLOCK') RETURNING id",
              [a.tenant, key],
            )
          ).rows[0].id;
          const id = randomUUID();
          ids.push(id);
          await migration.query(
            "INSERT INTO domain.retention_archive(id,event_id,tenant_id,category,target_key,subject_id,payload,destroy_after) VALUES($1,$2,$3,'COMMUNICATIONS',$4,'citizen','{}',now()-make_interval(days=>$5))",
            [id, event, a.tenant, key, 2 - index],
          );
        }
        await setRetentionHold(
          domain,
          actor("privacy"),
          a.tenant,
          {
            category: "COMMUNICATIONS",
            targetKey: "held-oldest",
            authorizationReference: "Hold authority",
            reason: "Evidence preservation",
          },
          randomUUID(),
        );
        const result = await batch(1);
        assert.equal(result.processed, 1);
        assert.equal(
          (
            await migration.query(
              "SELECT * FROM domain.retention_archive WHERE id=$1",
              [ids[0]],
            )
          ).rowCount,
          1,
        );
        assert.equal(
          (
            await migration.query(
              "SELECT * FROM domain.retention_archive WHERE id=$1",
              [ids[1]],
            )
          ).rowCount,
          0,
        );
      },
    );
  });
});
