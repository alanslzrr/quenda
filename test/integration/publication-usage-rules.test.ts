import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "pg";
import { migrate } from "../../scripts/lib/migrations.ts";
import { transaction } from "../../src/database/transaction.ts";
import {
  publicAvailability,
  publicUnitCalendar,
  publicUnits,
  publishCatalogResource,
  withdrawCatalogResource,
} from "../../src/modules/catalog/index.ts";
import {
  publicUsageRules,
  saveUsageRules,
} from "../../src/modules/catalog/usage-rules.ts";
import { withDatabase } from "../helpers/postgres.ts";

test("usage rules gate new publications and hide legacy offers without rewriting reservations", {
  timeout: 60000,
}, async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "quenda-rules-upgrade-"),
  );
  await cp(path.resolve("db/migrations"), directory, { recursive: true });
  for (const name of await readdir(directory))
    if (name.endsWith(".sql") && name >= "0062_")
      await rm(path.join(directory, name));
  try {
    await withDatabase(async ({ auth, domain, migration, worker }) => {
      const actor = {
        accountId: "publication-rules-admin",
        email: "publication-rules-admin@example.test",
        sessionId: "rules",
        mfaVerifiedAt: new Date(),
      };
      for (const id of [actor.accountId, "publication-rules-operator"])
        await auth.query(
          'INSERT INTO auth."user"(id,name,email,"emailVerified","twoFactorEnabled") VALUES($1,$1,$2,true,true)',
          [id, `${id}@example.test`],
        );
      const owner = new Client({
        connectionString: migration.options.connectionString,
      });
      await owner.connect();
      try {
        const tenantId = randomUUID(),
          facilityId = randomUUID(),
          invitationId = randomUUID();
        await owner.query(
          "INSERT INTO domain.municipality(id,name,timezone) VALUES($1,'Publication rules','Europe/Madrid')",
          [tenantId],
        );
        await owner.query(
          "INSERT INTO domain.municipal_profile(tenant_id,account_id) VALUES($1,$2)",
          [tenantId, actor.accountId],
        );
        await owner.query(
          "INSERT INTO domain.administrator_invitation(tenant_id,id,account_id,invited_by,expires_at,accepted_at) VALUES($1,$2,$3,$3,now()+interval '1 hour',now())",
          [tenantId, invitationId, actor.accountId],
        );
        await owner.query(
          "INSERT INTO domain.municipal_administrator(tenant_id,account_id,invitation_id) VALUES($1,$2,$3)",
          [tenantId, actor.accountId, invitationId],
        );
        await owner.query(
          "INSERT INTO domain.facility(tenant_id,id,name,published_at) VALUES($1,$2,'Rules facility',now())",
          [tenantId, facilityId],
        );
        const units = [];
        for (const name of ["Legacy", "Draft", "Withdrawn", "Whitespace"]) {
          const unitId = randomUUID();
          await owner.query(
            "INSERT INTO domain.reservable_unit(tenant_id,id,facility_id,name) VALUES($1,$2,$3,$4)",
            [tenantId, unitId, facilityId, name],
          );
          await owner.query(
            `INSERT INTO domain.unit_calendar_version(tenant_id,unit_id,version,minimum_minutes,maximum_minutes,step_minutes,weekly,exceptions,actor_id,reason)
          VALUES($1,$2,1,60,60,60,$3,'[]',$4,'Opening')`,
            [
              tenantId,
              unitId,
              JSON.stringify(
                Array.from({ length: 7 }, (_, day) => ({
                  day: day + 1,
                  startMinute: 480,
                  endMinute: 1200,
                })),
              ),
              actor.accountId,
            ],
          );
          await owner.query(
            "UPDATE domain.reservable_unit SET calendar_version=1 WHERE tenant_id=$1 AND id=$2",
            [tenantId, unitId],
          );
          units.push(unitId);
        }
        const [legacy, draft, withdrawn, whitespace] = units;
        assert.ok(legacy && draft && withdrawn && whitespace);
        // Genuine preceding-schema rows, not a bypass of the new constraints.
        await migration.query(
          `UPDATE domain.reservable_unit SET published_at='2026-01-01T00:00:00Z',
           withdrawn_at=CASE WHEN id=$3 THEN '2026-01-02T00:00:00Z'::timestamptz END
           WHERE tenant_id=$1 AND id<>$2`,
          [tenantId, draft, withdrawn],
        );
        await owner.query("BEGIN");
        try {
          await owner.query(
            "SELECT set_config('quenda.account_id',$1,true),set_config('quenda.tenant_id',$2,true)",
            [actor.accountId, tenantId],
          );
          await owner.query(
            "SELECT domain.save_unit_usage_rules($1,0,E'\\n\\t','Legacy whitespace',$2)",
            [whitespace, randomUUID()],
          );
          const reservationId = randomUUID();
          await owner.query(
            `INSERT INTO domain.reservation(tenant_id,id,account_id,unit_id,calendar_version,starts_at,ends_at,cancellation_minutes,timezone)
          VALUES($1,$2,$3,$4,1,'2030-01-02T10:00:00Z','2030-01-02T11:00:00Z',60,'Europe/Madrid')`,
            [tenantId, reservationId, actor.accountId, legacy],
          );
          await owner.query(
            `INSERT INTO domain.occupancy(tenant_id,id,unit_id,reservation_id,period)
          VALUES($1,$2,$3,$4,tstzrange('2030-01-02T10:00:00Z','2030-01-02T11:00:00Z','[)'))`,
            [tenantId, randomUUID(), legacy, reservationId],
          );
          await owner.query(
            "SELECT domain.append_reservation_event($1,$2,$3,NULL)",
            [reservationId, randomUUID(), randomUUID()],
          );
          await owner.query("COMMIT");
        } catch (error) {
          await owner.query("ROLLBACK");
          throw error;
        }
        const evidence = async () => ({
          reservation: (
            await migration.query(
              `SELECT tenant_id,id,account_id,unit_id,calendar_version,starts_at,ends_at,
               status,revision,cancellation_minutes,timezone,created_at FROM domain.reservation`,
            )
          ).rows,
          occupancy: (await migration.query("SELECT * FROM domain.occupancy"))
            .rows,
          events: (
            await migration.query(
              `SELECT tenant_id,id,reservation_id,revision,kind,actor_id,correlation_id,
               reason,before_state,after_state,occurred_at FROM domain.reservation_event`,
            )
          ).rows,
        });
        const before = await evidence();
        assert.equal(
          (await publicUnits(domain, tenantId, facilityId)).items.length,
          2,
        );
        await migrate(owner, path.resolve("db/migrations"));
        assert.deepEqual(await evidence(), before);
        assert.deepEqual(
          (
            await migration.query(
              "SELECT published_at,usage_rules_version FROM domain.reservable_unit WHERE tenant_id=$1 AND id=$2",
              [tenantId, legacy],
            )
          ).rows[0],
          {
            published_at: new Date("2026-01-01T00:00:00Z"),
            usage_rules_version: null,
          },
        );
        assert.deepEqual(await publicUnits(domain, tenantId, facilityId), {
          items: [],
          nextCursor: null,
        });
        for (const unitId of [legacy, draft, withdrawn, whitespace]) {
          await assert.rejects(publicUnitCalendar(domain, tenantId, unitId), {
            code: "NOT_FOUND",
          });
          await assert.rejects(publicUsageRules(domain, tenantId, unitId), {
            code: "NOT_FOUND",
          });
          await assert.rejects(
            publicAvailability(domain, tenantId, unitId, "2030-01-02", 60, {
              now: () => new Date("2030-01-01T00:00:00Z"),
            }),
            { code: "NOT_FOUND" },
          );
          assert.equal(
            (
              await domain.query(
                "SELECT * FROM domain.public_available_slots($1,$2,ARRAY['2030-01-02T12:00:00Z'::timestamptz],ARRAY['2030-01-02T13:00:00Z'::timestamptz])",
                [tenantId, unitId],
              )
            ).rowCount,
            0,
          );
          await assert.rejects(
            publishCatalogResource(domain, actor, tenantId, "unit", unitId, {
              reason: "Publish",
              calendarVersion: 1,
              independenceConfirmed: true,
            }),
            { code: "USAGE_RULES_REQUIRED" },
          );
        }
        await assert.rejects(
          transaction(
            domain,
            (client) =>
              client.query(
                "UPDATE domain.reservable_unit SET published_at=now() WHERE tenant_id=$1 AND id=$2",
                [tenantId, draft],
              ),
            { tenantId, accountId: actor.accountId },
          ),
          { code: "23514" },
        );
        await assert.rejects(
          transaction(
            domain,
            (client) =>
              client.query(
                "SELECT domain.save_unit_usage_rules($1,0,E'\\n\\t','Whitespace rejected',$2)",
                [draft, randomUUID()],
              ),
            { tenantId, accountId: actor.accountId },
          ),
          { code: "23514" },
        );
        for (const unitId of [legacy, draft, withdrawn])
          await saveUsageRules(
            domain,
            actor,
            tenantId,
            unitId,
            {
              expectedVersion: 0,
              text: "Respete el horario de la reserva.",
              reason: "Complete rules",
            },
            randomUUID(),
          );
        assert.deepEqual(
          (await publicUnits(domain, tenantId, facilityId)).items.map(
            (item) => item.id,
          ),
          [legacy],
        );
        const publicUnit = await publicUnitCalendar(domain, tenantId, legacy);
        assert.equal(publicUnit.bookingPolicyVersion, 1);
        assert.equal(publicUnit.usageRulesVersion, 1);
        const availability = await publicAvailability(
          domain,
          tenantId,
          legacy,
          "2030-01-02",
          60,
          { now: () => new Date("2030-01-01T00:00:00Z") },
        );
        assert.ok(availability.slots.length > 0);
        assert.ok(
          !availability.slots.some(
            (slot) =>
              Date.parse(slot.start.utc) === Date.parse("2030-01-02T10:00:00Z"),
          ),
        );
        await publishCatalogResource(domain, actor, tenantId, "unit", draft, {
          reason: "Publish complete unit",
          calendarVersion: 1,
          independenceConfirmed: true,
        });
        assert.equal(
          (await publicUnits(domain, tenantId, facilityId)).items.length,
          2,
        );
        assert.deepEqual(await publicUsageRules(domain, tenantId, legacy), {
          tenantId,
          unitId: legacy,
          version: 1,
          text: "Respete el horario de la reserva.",
        });
        await withdrawCatalogResource(
          domain,
          actor,
          tenantId,
          "facility",
          facilityId,
          "Close facility",
        );
        assert.equal(
          (await publicUnits(domain, tenantId, facilityId)).items.length,
          0,
        );
        assert.deepEqual(await evidence(), before);
        for (const pool of [auth, worker])
          await assert.rejects(
            pool.query("SELECT * FROM domain.public_units($1,$2,NULL)", [
              tenantId,
              facilityId,
            ]),
            { code: "42501" },
          );
      } finally {
        await owner.end();
      }
    }, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
