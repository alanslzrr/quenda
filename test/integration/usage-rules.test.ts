import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { initializeOperator } from "../../scripts/lib/initialize-operator.ts";
import { transaction } from "../../src/database/transaction.ts";
import {
  createFacility,
  createReservableUnit,
  publishCatalogResource,
  saveUnitCalendar,
  withdrawCatalogResource,
} from "../../src/modules/catalog/index.ts";
import {
  publicUsageRules,
  readUsageRules,
  saveUsageRules,
} from "../../src/modules/catalog/usage-rules.ts";
import {
  acceptAdministratorInvitation,
  createMunicipality,
} from "../../src/modules/identity/index.ts";
import { withDatabase } from "../helpers/postgres.ts";

test("usage rules preserve immutable versions, scope, publication and atomic concurrency", {
  timeout: 60000,
}, async () => {
  await withDatabase(async ({ domain, auth, migration, worker }) => {
    const actor = {
      accountId: "rules-admin",
      email: "rules-admin@example.test",
      sessionId: "rules",
      mfaVerifiedAt: new Date(),
    };
    for (const id of [actor.accountId, "outsider", "operator"])
      await auth.query(
        'INSERT INTO auth."user"(id,name,email,"emailVerified","twoFactorEnabled") VALUES($1,$1,$2,true,true)',
        [id, `${id}@example.test`],
      );
    const owner = await migration.connect();
    try {
      await initializeOperator(owner, "operator");
    } finally {
      owner.release();
    }
    const { tenantId, invitationId } = await createMunicipality(
      domain,
      { ...actor, accountId: "operator", email: "operator@example.test" },
      {
        name: "Rules",
        timezone: "Europe/Madrid",
        administratorEmail: actor.email,
        invitationExpiresAt: new Date(Date.now() + 3600000).toISOString(),
      },
    );
    await acceptAdministratorInvitation(domain, actor, tenantId, invitationId);
    const { facilityId } = await createFacility(domain, actor, tenantId, {
      name: "Rules facility",
    });
    const { unitId } = await createReservableUnit(
      domain,
      actor,
      tenantId,
      facilityId,
      { name: "Rules unit" },
    );
    const input = {
      expectedVersion: 0,
      text: "Uso con calzado deportivo.\nRespete el horario.",
      reason: "Normas iniciales",
    };
    const save = (body = input) =>
      saveUsageRules(domain, actor, tenantId, unitId, body, randomUUID());
    await assert.rejects(readUsageRules(domain, actor, tenantId, unitId), {
      code: "NOT_FOUND",
    });
    await assert.rejects(publicUsageRules(domain, tenantId, unitId), {
      code: "NOT_FOUND",
    });
    for (const who of [
      { ...actor, mfaVerifiedAt: null },
      { ...actor, accountId: "outsider" },
    ]) {
      await assert.rejects(
        saveUsageRules(domain, who, tenantId, unitId, input, randomUUID()),
        { code: "FORBIDDEN" },
      );
      await assert.rejects(readUsageRules(domain, who, tenantId, unitId), {
        code: "FORBIDDEN",
      });
    }
    await assert.rejects(
      saveUsageRules(domain, actor, randomUUID(), unitId, input, randomUUID()),
      { code: "FORBIDDEN" },
    );
    for (const invalid of [
      { ...input, text: " " },
      { ...input, text: "x".repeat(20001) },
      { ...input, text: "\0" },
      { ...input, reason: " " },
      { ...input, expectedVersion: -1 },
      { ...input, expectedVersion: 2147483647 },
    ])
      await assert.rejects(save(invalid), { code: "INVALID_INPUT" });
    const first = await save();
    assert.equal(first.text, input.text);
    assert.equal(first.version, 1);
    assert.equal(first.actorId, actor.accountId);
    assert.ok(first.correlationId);
    const competing = await Promise.allSettled([
      save({ ...input, expectedVersion: 1, text: "A" }),
      save({ ...input, expectedVersion: 1, text: "B" }),
    ]);
    assert.equal(competing.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(
      competing.filter(
        (r) => r.status === "rejected" && r.reason.code === "STALE_VERSION",
      ).length,
      1,
    );
    const current = await readUsageRules(domain, actor, tenantId, unitId);
    assert.equal(current.version, 2);
    assert.deepEqual(
      await readUsageRules(domain, actor, tenantId, unitId, 1),
      first,
    );
    await assert.rejects(readUsageRules(domain, actor, tenantId, unitId, 3), {
      code: "NOT_FOUND",
    });
    await assert.rejects(publicUsageRules(domain, tenantId, unitId), {
      code: "NOT_FOUND",
    });
    assert.equal(
      (await domain.query("SELECT * FROM domain.unit_usage_rules")).rowCount,
      0,
    );
    for (const pool of [auth, worker])
      await assert.rejects(
        pool.query("SELECT * FROM domain.unit_usage_rules"),
        { code: "42501" },
      );
    for (const sql of [
      "UPDATE domain.unit_usage_rules SET text_content='Changed'",
      "DELETE FROM domain.unit_usage_rules",
      "UPDATE domain.reservable_unit SET usage_rules_version=1",
    ])
      await assert.rejects(
        transaction(domain, (client) => client.query(sql), {
          accountId: actor.accountId,
          tenantId,
        }),
        { code: "42501" },
      );
    await assert.rejects(
      domain.query(
        "SELECT domain.save_unit_usage_rules($1,2,'X','No context',$2)",
        [unitId, randomUUID()],
      ),
      { code: "42501" },
    );
    await migration.query(
      "CREATE FUNCTION domain.fail_rules() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic pointer failure'; END $$; CREATE TRIGGER fail_rules BEFORE UPDATE OF usage_rules_version ON domain.reservable_unit FOR EACH ROW EXECUTE FUNCTION domain.fail_rules()",
    );
    try {
      await assert.rejects(save({ ...input, expectedVersion: 2 }));
      assert.deepEqual(
        await readUsageRules(domain, actor, tenantId, unitId),
        current,
      );
      assert.equal(
        (
          await migration.query(
            "SELECT count(*)::integer AS n FROM domain.unit_usage_rules",
          )
        ).rows[0].n,
        2,
      );
    } finally {
      await migration.query(
        "DROP TRIGGER fail_rules ON domain.reservable_unit; DROP FUNCTION domain.fail_rules()",
      );
    }
    await saveUnitCalendar(domain, actor, tenantId, unitId, {
      expectedVersion: 0,
      reason: "Opening",
      calendar: {
        minimumMinutes: 60,
        maximumMinutes: 60,
        stepMinutes: 60,
        advanceDays: null,
        weekly: [{ day: 1, startMinute: 480, endMinute: 1200 }],
        exceptions: [],
      },
    });
    await publishCatalogResource(
      domain,
      actor,
      tenantId,
      "facility",
      facilityId,
      { reason: "Publish" },
    );
    await publishCatalogResource(domain, actor, tenantId, "unit", unitId, {
      reason: "Publish",
      calendarVersion: 1,
      independenceConfirmed: true,
    });
    assert.deepEqual(await publicUsageRules(domain, tenantId, unitId), {
      tenantId,
      unitId,
      version: 2,
      text: current.text,
    });
    await withdrawCatalogResource(
      domain,
      actor,
      tenantId,
      "facility",
      facilityId,
      "Close",
    );
    await assert.rejects(publicUsageRules(domain, tenantId, unitId), {
      code: "NOT_FOUND",
    });
    assert.deepEqual(
      await readUsageRules(domain, actor, tenantId, unitId, 1),
      first,
    );
  });
});
