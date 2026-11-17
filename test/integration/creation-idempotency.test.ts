import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { initializeOperator } from "../../scripts/lib/initialize-operator.ts";
import { transaction } from "../../src/database/transaction.ts";
import {
  createFacility,
  createReservableUnit,
} from "../../src/modules/catalog/drafts.ts";
import {
  acceptAdministratorInvitation,
  createMunicipality,
} from "../../src/modules/identity/municipality.ts";
import { withDatabase } from "../helpers/postgres.ts";

const actor = (id: string) => ({
  accountId: id,
  email: `${id}@example.test`,
  sessionId: `s-${id}`,
  mfaVerifiedAt: new Date(),
});
test("municipality and catalog creation replay atomically under current authorization", {
  timeout: 60000,
}, async () => {
  await withDatabase(async ({ auth, domain, migration, worker }) => {
    for (const id of ["operator", "admin", "other"])
      await auth.query(
        'INSERT INTO auth."user"(id,name,email,"emailVerified","twoFactorEnabled") VALUES($1,$1,$2,true,true)',
        [id, `${id}@example.test`],
      );
    const connection = await migration.connect();
    try {
      await initializeOperator(connection, "operator");
    } finally {
      connection.release();
    }
    const input = {
      name: "Creation",
      timezone: "Europe/Madrid",
      administratorEmail: "admin@example.test",
      invitationExpiresAt: new Date(Date.now() + 3600000).toISOString(),
    };
    const [first, replayed] = await Promise.all([
      createMunicipality(domain, actor("operator"), input, "create-once"),
      createMunicipality(domain, actor("operator"), input, "create-once"),
    ]);
    assert.deepEqual(first, replayed);
    assert.equal(
      (await migration.query("SELECT count(*)::int n FROM domain.municipality"))
        .rows[0].n,
      1,
    );
    assert.equal(
      (
        await migration.query(
          "SELECT count(*)::int n FROM domain.identity_event",
        )
      ).rows[0].n,
      2,
    );
    await assert.rejects(
      createMunicipality(
        domain,
        actor("operator"),
        { ...input, name: "Different" },
        "create-once",
      ),
      { code: "IDEMPOTENCY_KEY_REUSED" },
    );
    await assert.rejects(
      createMunicipality(domain, actor("other"), input, "create-once"),
      { code: "FORBIDDEN" },
    );
    await assert.rejects(
      transaction(
        domain,
        (client) =>
          client.query(
            "INSERT INTO domain.idempotent_command(tenant_id,actor_id,operation,key,fingerprint,created_at,expires_at) VALUES(NULL,'operator','municipality.create','unfinished',$1,now(),now()+interval '1 hour')",
            ["a".repeat(64)],
          ),
        { accountId: "operator", tenantId: null },
      ),
      { code: "23514" },
    );
    await acceptAdministratorInvitation(
      domain,
      actor("admin"),
      first.tenantId,
      first.invitationId,
    );
    const facilities = await Promise.all([
      createFacility(
        domain,
        actor("admin"),
        first.tenantId,
        { name: "Hall" },
        "facility-once",
      ),
      createFacility(
        domain,
        actor("admin"),
        first.tenantId,
        { name: " Hall " },
        "facility-once",
      ),
    ]);
    assert.deepEqual(facilities[0], facilities[1]);
    const facility = facilities[0];
    assert.ok(facility);
    const unit = await createReservableUnit(
      domain,
      actor("admin"),
      first.tenantId,
      facility.facilityId,
      { name: "Court" },
      "unit-once",
    );
    assert.deepEqual(
      await createReservableUnit(
        domain,
        actor("admin"),
        first.tenantId,
        facility.facilityId,
        { name: "Court" },
        "unit-once",
      ),
      unit,
    );
    await assert.rejects(
      createReservableUnit(
        domain,
        actor("admin"),
        first.tenantId,
        randomUUID(),
        { name: "Court" },
        "unit-once",
      ),
      { code: "IDEMPOTENCY_KEY_REUSED" },
    );
    await assert.rejects(
      createFacility(
        domain,
        actor("other"),
        first.tenantId,
        { name: "Hall" },
        "facility-once",
      ),
      { code: "FORBIDDEN" },
    );
    const count = await migration.query(
      "SELECT (SELECT count(*) FROM domain.facility)::int facilities,(SELECT count(*) FROM domain.reservable_unit)::int units,(SELECT count(*) FROM domain.catalog_event)::int events",
    );
    assert.deepEqual(count.rows[0], { facilities: 1, units: 1, events: 2 });
    await migration.query(
      "UPDATE domain.platform_operator SET revoked_at=now() WHERE account_id='operator'",
    );
    await assert.rejects(
      createMunicipality(domain, actor("operator"), input, "create-once"),
      { code: "FORBIDDEN" },
    );
    await migration.query(
      "UPDATE domain.idempotent_command SET expires_at=now()-interval '1 second',created_at=now()-interval '1 hour' WHERE tenant_id IS NULL",
    );
    assert.equal(
      (
        await worker.query(
          "SELECT domain.purge_expired_idempotent_commands(1) n",
        )
      ).rows[0].n,
      1,
    );
  });
});
