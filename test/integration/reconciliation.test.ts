import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { Client } from "pg";
import { createBackup } from "../../scripts/lib/backup.ts";
import { reconcileRestore } from "../../scripts/lib/reconcile.ts";
import { restoreBackup } from "../../scripts/lib/restore.ts";
import {
  acceptReservationUsageRules,
  cancelReservation,
  createReservation,
  modifyReservation,
} from "../../src/modules/reservations/index.ts";
import { withDatabase } from "../helpers/postgres.ts";
import { recoveryFixture } from "../helpers/recovery-fixture.ts";
import {
  initialAcceptance,
  seedUsageRules,
} from "../helpers/usage-rules-fixture.ts";

const execute = promisify(execFile);
test("restored database reconciliation is read-only, detects inconsistent occupancy and keeps mail closed", {
  timeout: 60000,
}, async () => {
  await withDatabase(
    async ({ root, auth, migration, domain, administration }) => {
      const { tenants, units } = await recoveryFixture(auth, migration);
      await createReservation(
        domain,
        {
          accountId: "citizen",
          email: "citizen@example.test",
          sessionId: "fixture",
          mfaVerifiedAt: null,
        },
        tenants[0],
        "reconcile-booking",
        {
          acceptance: initialAcceptance,
          unitId: units[0],
          startsAt: "2030-04-03T10:00:00Z",
          endsAt: "2030-04-03T11:00:00Z",
        },
        randomUUID(),
        3600,
        { now: () => new Date("2030-04-02T00:00:00Z") },
      );
      const block = randomUUID();
      const setup = await administration.connect();
      try {
        await setup.query("BEGIN");
        await setup.query(
          "INSERT INTO domain.schedule_block(tenant_id,id,unit_id,starts_at,ends_at,actor_id,reason) VALUES($1,$2,$3,'2030-04-04T10:00:00Z','2030-04-04T11:00:00Z','citizen','Synthetic recovery block')",
          [tenants[0], block, units[0]],
        );
        await setup.query(
          "INSERT INTO domain.occupancy(tenant_id,id,unit_id,block_id,period) VALUES($1,$2,$3,$4,'[2030-04-04T10:00:00Z,2030-04-04T11:00:00Z)')",
          [tenants[0], randomUUID(), units[0], block],
        );
        await setup.query("COMMIT");
      } finally {
        setup.release();
      }
      const source = administration.options.connectionString as string;
      const bin = process.env.PG_BIN as string;
      const backup = await createBackup(
        source,
        path.join(root, "reconcile.dump"),
        bin,
      );
      await restoreBackup(
        source,
        backup.path,
        backup.sha256,
        "reconcile_closed",
        bin,
      );
      const url = new URL(source);
      url.pathname = "/reconcile_closed";
      const run = (connection = url.toString()) =>
        execute(process.execPath, ["scripts/reconcile.ts"], {
          env: { ...process.env, RESTORE_ADMIN_DATABASE_URL: connection },
          timeout: 30000,
        });
      const admin = new Client({ connectionString: url.toString() });
      await admin.connect();
      try {
        const snapshot = async () =>
          (
            await admin.query(
              "SELECT to_jsonb(q) AS row FROM domain.reservation_email q ORDER BY event_id",
            )
          ).rows;
        const before = await snapshot();
        const report = JSON.parse((await run()).stdout);
        assert.equal(report.status, "CHECKED_REQUIRES_REVIEW");
        assert.equal(report.reopeningAuthorized, false);
        assert.equal(report.connectionLimit, 0);
        assert.ok(Object.values(report.checks).every((n) => n === 0));
        assert.equal(report.mail.pending, 1);
        assert.equal(report.mail.accepted, 0);
        assert.deepEqual(await snapshot(), before);
        assert.ok(!JSON.stringify(report).includes("citizen"));
        // Controlled corruption in the disposable restored database only.
        await admin.query("BEGIN");
        await admin.query("SET LOCAL session_replication_role=replica");
        await admin.query("DELETE FROM domain.occupancy");
        await admin.query(
          "UPDATE domain.agreement_consumption SET week_start=week_start+1",
        );
        await admin.query(
          "UPDATE domain.reservation_event SET kind='CANCELADA'",
        );
        await admin.query(
          "UPDATE quenda_meta.migrations SET sha256=repeat('0',64) WHERE filename=(SELECT min(filename) FROM quenda_meta.migrations)",
        );
        await admin.query("COMMIT");
        await assert.rejects(run(), (error: unknown) => {
          const failure = error as { code: number; stdout: string };
          assert.equal(failure.code, 2);
          const broken = JSON.parse(failure.stdout);
          assert.equal(broken.status, "INCONSISTENT");
          assert.equal(broken.checks.reservationOccupancy, 1);
          assert.equal(broken.checks.blockOccupancy, 1);
          assert.equal(broken.checks.consumptionConsistency, 1);
          assert.equal(broken.checks.reservationEvents, 1);
          assert.equal(broken.checks.migrationHistory, 1);
          assert.equal(broken.reopeningAuthorized, false);
          return true;
        });
        await admin.query("DELETE FROM domain.agreement_consumption");
        await assert.rejects(run(), (error: unknown) => {
          const failure = error as { code: number; stdout: string };
          assert.equal(failure.code, 2);
          assert.equal(
            JSON.parse(failure.stdout).checks.missingConsumptions,
            1,
          );
          return true;
        });
        assert.deepEqual(await snapshot(), before);
        assert.equal(
          (
            await admin.query(
              "SELECT datconnlimit FROM pg_database WHERE datname=current_database()",
            )
          ).rows[0].datconnlimit,
          0,
        );
        await assert.rejects(
          run(domain.options.connectionString as string),
          (error: unknown) => {
            const failure = error as {
              code: number;
              stdout: string;
              stderr: string;
            };
            assert.equal(failure.code, 1);
            assert.equal(failure.stdout, "");
            assert.ok(!failure.stderr.includes("citizen"));
            return true;
          },
        );
      } finally {
        await admin.end();
      }
    },
  );
});

test("reconciliation retains released consumption history and detects missing evidence", {
  timeout: 60000,
}, async () => {
  await withDatabase(async ({ auth, migration, domain, administration }) => {
    const { tenants, units } = await recoveryFixture(auth, migration);
    const actor = {
      accountId: "citizen",
      email: "citizen@example.test",
      sessionId: "fixture",
      mfaVerifiedAt: null,
    };
    const clock = { now: () => new Date("2030-04-02T00:00:00Z") };
    const booking = await createReservation(
      domain,
      actor,
      tenants[0],
      "history-booking",
      {
        acceptance: initialAcceptance,
        unitId: units[0],
        startsAt: "2030-04-03T10:00:00Z",
        endsAt: "2030-04-03T11:00:00Z",
      },
      randomUUID(),
      3600,
      clock,
    );
    await cancelReservation(
      domain,
      actor,
      tenants[0],
      booking.result.id,
      "history-cancel",
      { expectedRevision: 1 },
      randomUUID(),
      3600,
      clock,
    );
    const client = new Client({
      connectionString: administration.options.connectionString,
    });
    await client.connect();
    try {
      const directory = path.resolve("db/migrations");
      const valid = await reconcileRestore(client, directory);
      assert.equal(valid.status, "CHECKED_REQUIRES_REVIEW");
      assert.ok(Object.values(valid.checks).every((n) => n === 0));
      assert.equal(
        (
          await client.query(
            "SELECT released FROM domain.agreement_consumption",
          )
        ).rows[0].released,
        true,
      );
      await client.query("DELETE FROM domain.agreement_consumption_event");
      const broken = await reconcileRestore(client, directory);
      assert.equal(broken.status, "INCONSISTENT");
      assert.equal(broken.checks.missingConsumptionEvidence, 1);
      assert.equal(broken.reopeningAuthorized, false);
    } finally {
      await client.end();
    }
  });
});

test("reconciliation checks acceptance evidence, legacy snapshots and sessions of deactivated accounts", {
  timeout: 60000,
}, async () => {
  await withDatabase(async ({ auth, migration, domain, administration }) => {
    const { tenants, units } = await recoveryFixture(auth, migration);
    const booking = await createReservation(
      domain,
      {
        accountId: "citizen",
        email: "citizen@example.test",
        sessionId: "fixture",
        mfaVerifiedAt: null,
      },
      tenants[0],
      "acceptance-reconcile",
      {
        acceptance: initialAcceptance,
        unitId: units[0],
        startsAt: "2030-04-03T10:00:00Z",
        endsAt: "2030-04-03T11:00:00Z",
      },
      randomUUID(),
      3600,
      { now: () => new Date("2030-04-02T00:00:00Z") },
    );
    const admin = new Client({
      connectionString: administration.options.connectionString,
    });
    await admin.connect();
    const run = () => reconcileRestore(admin, path.resolve("db/migrations"));
    try {
      // The report must not depend on the operator connection's timezone.
      await admin.query("SET TIME ZONE 'Pacific/Auckland'");
      const valid = await run();
      assert.ok(Object.values(valid.checks).every((n) => n === 0));
      const original = (
        await admin.query(
          "SELECT after_state FROM domain.reservation_event WHERE reservation_id=$1",
          [booking.result.id],
        )
      ).rows[0].after_state;
      const corrupt = async (sql: string, values: unknown[] = []) => {
        await admin.query("BEGIN");
        try {
          await admin.query("SET LOCAL session_replication_role=replica");
          await admin.query(sql, values);
          await admin.query("COMMIT");
        } catch (error) {
          await admin.query("ROLLBACK");
          throw error;
        }
      };
      await corrupt(
        "UPDATE domain.reservation_event SET after_state=jsonb_set(after_state,'{rulesAcceptedAt}','null'::jsonb) WHERE reservation_id=$1",
        [booking.result.id],
      );
      const changed = await run();
      assert.equal(changed.checks.reservationSnapshots, 1);
      assert.equal(changed.checks.reservationAcceptance, 0);
      await corrupt(
        "UPDATE domain.reservation_event SET after_state=$2 WHERE reservation_id=$1",
        [booking.result.id, original],
      );
      const originalRules = (
        await admin.query(
          "SELECT to_jsonb(u) AS value FROM domain.unit_usage_rules u WHERE tenant_id=$1 AND unit_id=$2",
          [tenants[0], units[0]],
        )
      ).rows[0].value;
      await corrupt(
        "DELETE FROM domain.unit_usage_rules WHERE tenant_id=$1 AND unit_id=$2",
        [tenants[0], units[0]],
      );
      const missingRules = await run();
      assert.equal(missingRules.checks.reservationAcceptance, 1);
      assert.equal(missingRules.reopeningAuthorized, false);
      await admin.query(
        "INSERT INTO domain.unit_usage_rules SELECT * FROM jsonb_populate_record(NULL::domain.unit_usage_rules,$1::jsonb)",
        [originalRules],
      );
      // Snapshots from before explicit accepted-unit references remain valid
      // only when their evidence still belongs to the current unit.
      await corrupt(
        "UPDATE domain.reservation_event SET after_state=after_state-ARRAY['usageRulesUnitId','pendingUsageRulesVersion'] WHERE reservation_id=$1",
        [booking.result.id],
      );
      const previousFormat = await run();
      assert.equal(previousFormat.checks.reservationSnapshots, 0);
      await corrupt(
        "UPDATE domain.reservation_event SET after_state=$2::jsonb-'usageRulesUnitId' WHERE reservation_id=$1",
        [booking.result.id, original],
      );
      assert.equal((await run()).checks.reservationSnapshots, 1);
      await corrupt(
        "UPDATE domain.reservation_event SET after_state=$2 WHERE reservation_id=$1",
        [booking.result.id, original],
      );
      // A legacy record may lack all acceptance fields; its historical snapshot
      // remains valid without rewriting it to manufacture null-valued evidence.
      await corrupt(
        "UPDATE domain.reservation SET usage_rules_unit_id=NULL,usage_rules_version=NULL,rules_accepted_at=NULL,booking_policy_version=NULL,conditions_accepted_at=NULL,non_cancellable_accepted=NULL WHERE id=$1",
        [booking.result.id],
      );
      await corrupt(
        "UPDATE domain.reservation_event SET after_state=after_state-ARRAY['usageRulesUnitId','pendingUsageRulesVersion','usageRulesVersion','rulesAcceptedAt','bookingPolicyVersion','conditionsAcceptedAt','nonCancellableAccepted'] WHERE reservation_id=$1",
        [booking.result.id],
      );
      const legacy = await run();
      assert.equal(legacy.checks.reservationAcceptance, 0);
      assert.equal(legacy.checks.reservationSnapshots, 0);
      assert.equal(legacy.status, "CHECKED_REQUIRES_REVIEW");
      await corrupt(
        `INSERT INTO auth.session(id,token,"userId","expiresAt","createdAt","updatedAt") VALUES('retained-session','synthetic-token','citizen',now()+interval '1 day',now(),now())`,
      );
      await corrupt(
        "UPDATE auth.account_lifecycle SET deactivated_at=now() WHERE account_id='citizen'",
      );
      const inactive = await run();
      assert.equal(inactive.checks.inactiveAccountSessions, 1);
      assert.equal(inactive.status, "INCONSISTENT");
      assert.ok(!JSON.stringify(inactive).includes("synthetic-token"));
      assert.ok(!JSON.stringify(inactive).includes("citizen"));
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM auth.session WHERE id='retained-session'",
          )
        ).rows[0].n,
        1,
      );
    } finally {
      await admin.end();
    }
  });
});

test("reconciliation validates relocated and historical acceptance independently of cancellation evidence", {
  timeout: 60000,
}, async () => {
  await withDatabase(async ({ auth, migration, domain, administration }) => {
    const { tenants, units } = await recoveryFixture(auth, migration);
    const tenant = tenants[0],
      source = units[0],
      destination = randomUUID(),
      invitation = randomUUID();
    await auth.query(
      `INSERT INTO auth."user"(id,name,email,"emailVerified") VALUES('reconcile-admin','Reconcile admin','reconcile-admin@example.test',true)`,
    );
    await migration.query(
      "INSERT INTO domain.municipal_profile(tenant_id,account_id) VALUES($1,'reconcile-admin')",
      [tenant],
    );
    await migration.query(
      "INSERT INTO domain.administrator_invitation(tenant_id,id,account_id,invited_by,expires_at,accepted_at) VALUES($1,$2,'reconcile-admin','reconcile-admin',now()+interval '1 day',now())",
      [tenant, invitation],
    );
    await migration.query(
      "INSERT INTO domain.municipal_administrator(tenant_id,account_id,invitation_id) VALUES($1,'reconcile-admin',$2)",
      [tenant, invitation],
    );
    await migration.query(
      "INSERT INTO domain.reservable_unit(tenant_id,id,facility_id,name) SELECT tenant_id,$3,facility_id,'Recovery destination' FROM domain.reservable_unit WHERE tenant_id=$1 AND id=$2",
      [tenant, source, destination],
    );
    await migration.query(
      "INSERT INTO domain.unit_calendar_version(tenant_id,unit_id,version,minimum_minutes,maximum_minutes,step_minutes,weekly,exceptions,actor_id,reason) SELECT tenant_id,$3,1,minimum_minutes,maximum_minutes,step_minutes,weekly,exceptions,actor_id,'Recovery fixture' FROM domain.unit_calendar_version WHERE tenant_id=$1 AND unit_id=$2 AND version=1",
      [tenant, source, destination],
    );
    await seedUsageRules(migration, tenant, destination, "reconcile-admin");
    await migration.query(
      "UPDATE domain.reservable_unit SET calendar_version=1,published_at=now() WHERE tenant_id=$1 AND id=$2",
      [tenant, destination],
    );
    const holder = {
      accountId: "citizen",
      email: "citizen@example.test",
      sessionId: "holder-session",
      mfaVerifiedAt: null,
    };
    const manager = {
      accountId: "reconcile-admin",
      email: "reconcile-admin@example.test",
      sessionId: "manager-session",
      mfaVerifiedAt: new Date(),
    };
    const clock = { now: () => new Date("2030-04-02T00:00:00Z") };
    const admin = new Client({
      connectionString: administration.options.connectionString,
    });
    await admin.connect();
    const run = () => reconcileRestore(admin, path.resolve("db/migrations"));
    const corrupt = async (sql: string, values: unknown[] = []) => {
      await admin.query("BEGIN");
      try {
        await admin.query("SET LOCAL session_replication_role=replica");
        await admin.query(sql, values);
        await admin.query("COMMIT");
      } catch (error) {
        await admin.query("ROLLBACK");
        throw error;
      }
    };
    const assertValid = async () => {
      const report = await run();
      assert.equal(report.status, "CHECKED_REQUIRES_REVIEW");
      assert.ok(Object.values(report.checks).every((n) => n === 0));
      assert.equal(report.reopeningAuthorized, false);
    };
    try {
      for (const legacy of [false, true]) {
        const day = legacy ? "10" : "03";
        const interval = {
          startsAt: `2030-04-${day}T10:00:00Z`,
          endsAt: `2030-04-${day}T11:00:00Z`,
        };
        const created = (
          await createReservation(
            domain,
            holder,
            tenant,
            `reconcile-create-${legacy}`,
            { unitId: source, ...interval, acceptance: initialAcceptance },
            randomUUID(),
            3600,
            clock,
          )
        ).result;
        if (legacy) {
          await corrupt(
            "UPDATE domain.reservation SET usage_rules_unit_id=NULL,usage_rules_version=NULL,rules_accepted_at=NULL,booking_policy_version=NULL,conditions_accepted_at=NULL,non_cancellable_accepted=NULL WHERE id=$1",
            [created.id],
          );
          await corrupt(
            "UPDATE domain.reservation_event e SET after_state=domain.reservation_snapshot(r) FROM domain.reservation r WHERE r.id=$1 AND e.reservation_id=r.id",
            [created.id],
          );
        }
        const moved = (
          await modifyReservation(
            domain,
            manager,
            tenant,
            created.id,
            `reconcile-move-${legacy}`,
            {
              expectedRevision: 1,
              unitId: destination,
              ...interval,
              administrative: true,
              reason: "Synthetic recovery relocation",
            },
            randomUUID(),
            3600,
            clock,
          )
        ).result;
        assert.equal(moved.pendingUsageRulesVersion, 1);
        assert.equal(moved.usageRulesUnitId, legacy ? null : source);
        await assertValid();
        const originalSnapshot = (
          await admin.query(
            "SELECT after_state FROM domain.reservation_event WHERE reservation_id=$1 AND revision=2",
            [created.id],
          )
        ).rows[0].after_state;
        await corrupt(
          "UPDATE domain.reservation_event SET after_state=after_state-ARRAY['usageRulesUnitId','pendingUsageRulesVersion'] WHERE reservation_id=$1 AND revision=2",
          [created.id],
        );
        assert.equal((await run()).checks.reservationSnapshots, 1);
        await corrupt(
          "UPDATE domain.reservation_event SET after_state=$2 WHERE reservation_id=$1 AND revision=2",
          [created.id, originalSnapshot],
        );
        const pendingRules = (
          await admin.query(
            "SELECT to_jsonb(u) AS value FROM domain.unit_usage_rules u WHERE tenant_id=$1 AND unit_id=$2 AND version=1",
            [tenant, destination],
          )
        ).rows[0].value;
        await corrupt(
          "DELETE FROM domain.unit_usage_rules WHERE tenant_id=$1 AND unit_id=$2",
          [tenant, destination],
        );
        assert.ok(((await run()).checks.reservationAcceptance ?? 0) > 0);
        await admin.query(
          "INSERT INTO domain.unit_usage_rules SELECT * FROM jsonb_populate_record(NULL::domain.unit_usage_rules,$1::jsonb)",
          [pendingRules],
        );
        const beforeMail = (
          await admin.query(
            "SELECT to_jsonb(e) AS row FROM domain.reservation_email e ORDER BY event_id",
          )
        ).rows;
        const accepted = (
          await acceptReservationUsageRules(
            domain,
            holder,
            tenant,
            created.id,
            `reconcile-accept-${legacy}`,
            {
              expectedRevision: 2,
              unitId: destination,
              usageRulesVersion: 1,
            },
            randomUUID(),
            3600,
            clock,
          )
        ).result;
        assert.equal(accepted.revision, 3);
        assert.equal(accepted.usageRulesUnitId, destination);
        assert.equal(accepted.pendingUsageRulesVersion, null);
        assert.equal(accepted.bookingPolicyVersion, legacy ? null : 1);
        assert.equal(
          accepted.conditionsAcceptedAt,
          legacy ? null : created.conditionsAcceptedAt,
        );
        await assertValid();
        assert.deepEqual(
          (
            await admin.query(
              "SELECT to_jsonb(e) AS row FROM domain.reservation_email e ORDER BY event_id",
            )
          ).rows,
          beforeMail,
        );
      }
    } finally {
      await admin.end();
    }
  });
});
