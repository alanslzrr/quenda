import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import swagger from "@fastify/swagger";
import Fastify from "fastify";
import { registerErrors } from "../../src/http/errors.ts";
import { inspectCatalogResource } from "../../src/modules/catalog/maintenance.ts";
import { saveCatalogProfile } from "../../src/modules/catalog/profile.ts";
import {
  publicFacilities,
  publicUnitCalendar,
  publicUnits,
} from "../../src/modules/catalog/public.ts";
import { registerCatalog } from "../../src/modules/catalog/routes.ts";
import type { Authentication } from "../../src/modules/identity/auth.ts";
import { withDatabase } from "../helpers/postgres.ts";
import { seedUsageRules } from "../helpers/usage-rules-fixture.ts";

test("facility and unit profiles are replaced under permission, versioned, audited and projected publicly", {
  timeout: 90000,
}, async () => {
  await withDatabase(async ({ auth, domain, migration }) => {
    const actor = (id: string, recent = true) => ({
      accountId: id,
      email: `${id}@example.test`,
      sessionId: id,
      mfaVerifiedAt: recent ? new Date() : new Date(Date.now() - 3600000),
    });
    for (const id of ["admin", "manager", "outsider", "other-admin"])
      await auth.query(
        'INSERT INTO auth."user"(id,name,email,"emailVerified","twoFactorEnabled") VALUES($1,$1,$2,true,true)',
        [id, `${id}@example.test`],
      );
    const makeTenant = async (name: string, administrator: string) => {
      const tenantId = randomUUID();
      const invitationId = randomUUID();
      await migration.query(
        "INSERT INTO domain.municipality(id,name,timezone) VALUES($1,$2,'Europe/Madrid')",
        [tenantId, name],
      );
      await migration.query(
        "INSERT INTO domain.municipal_profile(tenant_id,account_id) VALUES($1,$2)",
        [tenantId, administrator],
      );
      await migration.query(
        "INSERT INTO domain.administrator_invitation(tenant_id,id,account_id,invited_by,expires_at,accepted_at) VALUES($1,$2,$3,$3,now()+interval '1 hour',now())",
        [tenantId, invitationId, administrator],
      );
      await migration.query(
        "INSERT INTO domain.municipal_administrator(tenant_id,account_id,invitation_id) VALUES($1,$2,$3)",
        [tenantId, administrator, invitationId],
      );
      return tenantId;
    };
    const tenantId = await makeTenant("Perfil", "admin");
    const otherTenant = await makeTenant("Otro", "other-admin");
    const facilityId = randomUUID(),
      draftFacility = randomUUID(),
      unitId = randomUUID(),
      otherUnit = randomUUID();
    await migration.query(
      "INSERT INTO domain.facility(tenant_id,id,name,published_at) VALUES($1,$2,'Polideportivo',now()),($1,$3,'Borrador',NULL)",
      [tenantId, facilityId, draftFacility],
    );
    for (const [id, name] of [
      [unitId, "Pista 1"],
      [otherUnit, "Pista 2"],
    ] as const) {
      await migration.query(
        "INSERT INTO domain.reservable_unit(tenant_id,id,facility_id,name) VALUES($1,$2,$3,$4)",
        [tenantId, id, facilityId, name],
      );
      await migration.query(
        `INSERT INTO domain.unit_calendar_version(tenant_id,unit_id,version,minimum_minutes,maximum_minutes,step_minutes,weekly,exceptions,actor_id,reason)
         VALUES($1,$2,1,60,60,60,$3,'[]','admin','Fixture')`,
        [
          tenantId,
          id,
          JSON.stringify(
            Array.from({ length: 7 }, (_, day) => ({
              day: day + 1,
              startMinute: 480,
              endMinute: 1200,
            })),
          ),
        ],
      );
      await migration.query(
        "UPDATE domain.reservable_unit SET calendar_version=1 WHERE tenant_id=$1 AND id=$2",
        [tenantId, id],
      );
      await seedUsageRules(migration, tenantId, id, "admin");
      // Publication requires the rules to exist first.
      await migration.query(
        "UPDATE domain.reservable_unit SET published_at=now() WHERE tenant_id=$1 AND id=$2",
        [tenantId, id],
      );
    }
    // A manager who may maintain only one unit.
    await migration.query(
      "INSERT INTO domain.municipal_profile(tenant_id,account_id) VALUES($1,'manager')",
      [tenantId],
    );
    const invitation = randomUUID();
    await migration.query(
      `INSERT INTO domain.manager_invitation(tenant_id,id,account_id,invited_by,issuer_invitation_id,expires_at,accepted_at)
       SELECT $1,$2,'manager','admin',i.id,now()+interval '1 hour',now()
       FROM domain.administrator_invitation i WHERE i.tenant_id=$1 LIMIT 1`,
      [tenantId, invitation],
    );
    await migration.query(
      "INSERT INTO domain.manager_permission(tenant_id,invitation_id,operation,unit_id) VALUES($1,$2,'CATALOG_MANAGE',$3)",
      [tenantId, invitation, unitId],
    );
    await migration.query(
      "INSERT INTO domain.manager_grant(tenant_id,invitation_id,account_id) VALUES($1,$2,'manager')",
      [tenantId, invitation],
    );

    await test("a new resource has an empty profile at version 1", async () => {
      const facility = await inspectCatalogResource(
        domain,
        actor("admin"),
        tenantId,
        "facility",
        facilityId,
      );
      assert.deepEqual(facility.profile, {});
      assert.equal(facility.profileVersion, 1);
    });

    const full = {
      expectedVersion: 1,
      address: "  Rúa do Mar 4  ",
      postalCode: "15001",
      location: { latitude: 43.3623456789, longitude: -8.4115 },
      description: { gl: "Pavillón cuberto", es: "Pabellón cubierto" },
      accessibility: { es: "Acceso sin escalones" },
      contact: { phone: "+34 981 000 000", email: "deportes@concello.example" },
    };

    await test("saving replaces the profile, normalizes it and bumps the version", async () => {
      const saved = await saveCatalogProfile(
        domain,
        actor("admin"),
        tenantId,
        "facility",
        facilityId,
        full,
      );
      assert.equal(saved.profileVersion, 2);
      assert.deepEqual(saved.profile, {
        address: "Rúa do Mar 4",
        postalCode: "15001",
        location: { latitude: 43.362346, longitude: -8.4115 },
        description: { gl: "Pavillón cuberto", es: "Pabellón cubierto" },
        accessibility: { es: "Acceso sin escalones" },
        contact: {
          phone: "+34 981 000 000",
          email: "deportes@concello.example",
        },
      });
    });

    await test("a stale version conflicts and changes nothing", async () => {
      await assert.rejects(
        saveCatalogProfile(
          domain,
          actor("admin"),
          tenantId,
          "facility",
          facilityId,
          {
            ...full,
            address: "Otra",
          },
        ),
        { code: "CONFLICT" },
      );
      const row = (
        await migration.query(
          "SELECT address,profile_version FROM domain.facility WHERE tenant_id=$1 AND id=$2",
          [tenantId, facilityId],
        )
      ).rows[0];
      assert.deepEqual(row, { address: "Rúa do Mar 4", profile_version: 2 });
    });

    await test("every change is audited with before and after", async () => {
      const events = (
        await migration.query(
          "SELECT version,previous_state,next_state,unit_id FROM domain.catalog_profile_event WHERE tenant_id=$1 AND facility_id=$2 ORDER BY version",
          [tenantId, facilityId],
        )
      ).rows;
      assert.equal(events.length, 1);
      assert.equal(events[0].version, 2);
      assert.deepEqual(events[0].previous_state, {});
      assert.equal(events[0].next_state.postalCode, "15001");
      assert.equal(events[0].unit_id, null);
    });

    await test("absent fields are cleared and blank text counts as absent", async () => {
      const saved = await saveCatalogProfile(
        domain,
        actor("admin"),
        tenantId,
        "facility",
        facilityId,
        {
          expectedVersion: 2,
          address: "   ",
          description: { es: "Solo castellano" },
        },
      );
      assert.equal(saved.profileVersion, 3);
      assert.deepEqual(saved.profile, {
        description: { es: "Solo castellano" },
      });
      await saveCatalogProfile(
        domain,
        actor("admin"),
        tenantId,
        "facility",
        facilityId,
        {
          ...full,
          expectedVersion: 3,
        },
      );
    });

    await test("invalid values are rejected before and by the database", async () => {
      for (const bad of [
        { postalCode: "1500" },
        { location: { latitude: 100, longitude: 0 } },
        { contact: { email: "not-an-email" } },
        { contact: { phone: "call me" } },
        { address: "x".repeat(301) },
      ])
        await assert.rejects(
          saveCatalogProfile(
            domain,
            actor("admin"),
            tenantId,
            "facility",
            facilityId,
            {
              expectedVersion: 4,
              ...bad,
            } as never,
          ),
          { code: "INVALID_INPUT" },
          JSON.stringify(bad),
        );
      for (const sql of [
        "UPDATE domain.facility SET postal_code='abc' WHERE tenant_id=$1",
        "UPDATE domain.facility SET latitude=10,longitude=NULL WHERE tenant_id=$1",
        "UPDATE domain.facility SET contact_email='a@b' WHERE tenant_id=$1",
      ])
        await assert.rejects(
          migration.query(sql, [tenantId]),
          { code: "23514" },
          sql,
        );
      assert.equal(
        (
          await migration.query(
            "SELECT profile_version FROM domain.facility WHERE tenant_id=$1 AND id=$2",
            [tenantId, facilityId],
          )
        ).rows[0].profile_version,
        4,
      );
    });

    await test("units keep their own profile and a manager is limited to the unit they maintain", async () => {
      const saved = await saveCatalogProfile(
        domain,
        actor("manager"),
        tenantId,
        "unit",
        unitId,
        {
          expectedVersion: 1,
          kind: "padel",
          indoor: false,
          capacity: 4,
          description: { gl: "Cristal panorámico" },
        },
      );
      assert.deepEqual(saved.profile, {
        kind: "padel",
        indoor: false,
        capacity: 4,
        description: { gl: "Cristal panorámico" },
      });
      await assert.rejects(
        saveCatalogProfile(
          domain,
          actor("manager"),
          tenantId,
          "unit",
          otherUnit,
          {
            expectedVersion: 1,
            kind: "tenis",
          },
        ),
        { code: "FORBIDDEN" },
      );
      await assert.rejects(
        saveCatalogProfile(
          domain,
          actor("manager"),
          tenantId,
          "facility",
          facilityId,
          {
            ...full,
            expectedVersion: 4,
          },
        ),
        { code: "FORBIDDEN" },
      );
      for (const bad of [
        { kind: "cancha" },
        { capacity: 0 },
        { capacity: 1.5 },
      ])
        await assert.rejects(
          saveCatalogProfile(domain, actor("admin"), tenantId, "unit", unitId, {
            expectedVersion: 2,
            ...bad,
          } as never),
          { code: "INVALID_INPUT" },
        );
    });

    await test("a stale MFA check, an outsider and another municipality are refused", async () => {
      await assert.rejects(
        saveCatalogProfile(
          domain,
          actor("admin", false),
          tenantId,
          "facility",
          facilityId,
          {
            ...full,
            expectedVersion: 4,
          },
        ),
        { code: "REAUTHENTICATION_REQUIRED" },
      );
      await assert.rejects(
        saveCatalogProfile(
          domain,
          actor("outsider"),
          tenantId,
          "facility",
          facilityId,
          {
            ...full,
            expectedVersion: 4,
          },
        ),
        { code: "FORBIDDEN" },
      );
      await assert.rejects(
        saveCatalogProfile(
          domain,
          actor("other-admin"),
          otherTenant,
          "facility",
          facilityId,
          {
            ...full,
            expectedVersion: 4,
          },
        ),
        { code: "NOT_FOUND" },
      );
      await assert.rejects(
        inspectCatalogResource(
          domain,
          actor("other-admin"),
          otherTenant,
          "facility",
          facilityId,
        ),
        { code: "NOT_FOUND" },
      );
    });

    await test("public projections carry the profile of published resources only", async () => {
      const facilities = await publicFacilities(domain, tenantId);
      assert.deepEqual(
        facilities.items.map((item) => item.id),
        [facilityId],
      );
      assert.equal(facilities.items[0]?.units, 2);
      assert.deepEqual(facilities.items[0]?.profile, {
        address: "Rúa do Mar 4",
        postalCode: "15001",
        location: { latitude: 43.362346, longitude: -8.4115 },
        description: { gl: "Pavillón cuberto", es: "Pabellón cubierto" },
        accessibility: { es: "Acceso sin escalones" },
        contact: {
          phone: "+34 981 000 000",
          email: "deportes@concello.example",
        },
      });
      const units = await publicUnits(domain, tenantId, facilityId);
      const pista = units.items.find((item) => item.id === unitId);
      assert.ok(pista);
      assert.equal((pista.profile as { kind: string }).kind, "padel");
      const detail = await publicUnitCalendar(domain, tenantId, unitId);
      assert.deepEqual(detail.profile, {
        kind: "padel",
        indoor: false,
        capacity: 4,
        description: { gl: "Cristal panorámico" },
      });
      assert.equal(
        (detail.facilityProfile as { address?: string }).address,
        "Rúa do Mar 4",
      );
      // The draft facility is not listed and nothing of it leaks through another tenant.
      assert.equal(
        (await publicFacilities(domain, otherTenant)).items.length,
        0,
      );
      await migration.query(
        "UPDATE domain.facility SET withdrawn_at=now() WHERE tenant_id=$1 AND id=$2",
        [tenantId, facilityId],
      );
      assert.equal((await publicFacilities(domain, tenantId)).items.length, 0);
      await migration.query(
        "UPDATE domain.facility SET withdrawn_at=NULL WHERE tenant_id=$1 AND id=$2",
        [tenantId, facilityId],
      );
    });

    await test("HTTP exposes the profile on read and replaces it on PUT with strict validation", async () => {
      const app = Fastify({
        genReqId: () => randomUUID(),
        ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
      });
      registerErrors(app);
      await app.register(swagger, {
        openapi: { openapi: "3.0.3", info: { title: "t", version: "1" } },
      });
      await registerCatalog(
        app,
        domain,
        {
          authenticate: async () => actor("admin"),
        } as unknown as Authentication,
        { origin: "https://quenda.test", secret: "profile-test-secret" },
      );
      try {
        const base = `/api/municipalities/${tenantId}/facilities/${facilityId}`;
        const read = await app.inject({ url: base });
        assert.equal(read.statusCode, 200, read.body);
        assert.equal(read.json().profileVersion, 4);
        assert.equal(read.json().profile.postalCode, "15001");
        const put = (payload: object, origin = "https://quenda.test") =>
          app.inject({
            method: "PUT",
            url: `${base}/profile`,
            headers: { origin },
            payload,
          });
        const edited = {
          ...read.json().profile,
          expectedVersion: 4,
          address: "Nova rúa 1",
        };
        const ok = await put(edited);
        assert.equal(ok.statusCode, 200, ok.body);
        assert.equal(ok.json().profileVersion, 5);
        assert.equal(ok.json().profile.address, "Nova rúa 1");
        assert.equal((await put(edited)).statusCode, 409);
        for (const bad of [
          { expectedVersion: 5, unknown: true },
          { expectedVersion: 5, postalCode: "abc" },
          { expectedVersion: 5, location: { latitude: 1 } },
          { address: "sin versión" },
        ])
          assert.equal((await put(bad)).statusCode, 400, JSON.stringify(bad));
        assert.equal(
          (
            await put(
              { ...edited, expectedVersion: 5 },
              "https://untrusted.test",
            )
          ).statusCode,
          403,
        );
        const unit = await app.inject({
          method: "PUT",
          url: `/api/municipalities/${tenantId}/units/${unitId}/profile`,
          headers: { origin: "https://quenda.test" },
          payload: { expectedVersion: 2, kind: "tenis", capacity: 2 },
        });
        assert.equal(unit.statusCode, 200, unit.body);
        assert.equal(unit.json().profile.kind, "tenis");
      } finally {
        await app.close();
      }
    });
  });
});
