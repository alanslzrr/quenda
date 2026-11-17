import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import swagger from "@fastify/swagger";
import Fastify from "fastify";
import sharp from "sharp";
import { registerErrors } from "../../src/http/errors.ts";
import { inspectCatalogResource } from "../../src/modules/catalog/maintenance.ts";
import {
  addCatalogPhoto,
  catalogPhotoContent,
  describeCatalogPhoto,
  orderCatalogPhotos,
  publicPhotoContent,
  removeCatalogPhoto,
} from "../../src/modules/catalog/photos.ts";
import {
  publicFacilities,
  publicUnitDetail,
  publicUnits,
} from "../../src/modules/catalog/public.ts";
import { registerCatalog } from "../../src/modules/catalog/routes.ts";
import type { Authentication } from "../../src/modules/identity/auth.ts";
import { withDatabase } from "../helpers/postgres.ts";
import { seedUsageRules } from "../helpers/usage-rules-fixture.ts";

const alt = (text: string) => ({ gl: `${text} (gl)`, es: `${text} (es)` });

test("catalog photos are re-encoded, ordered, audited and public only with their resource", {
  timeout: 120000,
}, async () => {
  const image = (
    await sharp({
      create: { width: 2400, height: 1600, channels: 3, background: "#2d6a4f" },
    })
      .jpeg()
      .withExifMerge({ IFD0: { Make: "Synthetic" } })
      .toBuffer()
  ).toString("base64");
  await withDatabase(async ({ auth, domain, migration }) => {
    const actor = (id: string, recent = true) => ({
      accountId: id,
      email: `${id}@example.test`,
      sessionId: id,
      mfaVerifiedAt: recent ? new Date() : new Date(Date.now() - 3600000),
    });
    for (const id of ["admin", "manager", "other-admin"])
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
    const tenantId = await makeTenant("Fotos", "admin");
    const otherTenant = await makeTenant("Outro", "other-admin");
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
      await migration.query(
        "UPDATE domain.reservable_unit SET published_at=now() WHERE tenant_id=$1 AND id=$2",
        [tenantId, id],
      );
    }
    // A manager who may maintain only the first unit.
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

    const ids: string[] = [];
    await test("photos are added in order up to the limit, stored without metadata", async () => {
      for (let index = 1; index <= 6; index++) {
        const result = await addCatalogPhoto(
          domain,
          actor("admin"),
          tenantId,
          "facility",
          facilityId,
          {
            image,
            alt: { gl: `  Foto ${index} (gl) `, es: ` Foto ${index} (es)  ` },
          },
        );
        assert.equal(result.photos.length, index);
        ids.push(result.photos.at(-1)?.id ?? "");
      }
      const first = (
        await inspectCatalogResource(
          domain,
          actor("admin"),
          tenantId,
          "facility",
          facilityId,
        )
      ).photos[0];
      assert.deepEqual(first, {
        id: ids[0],
        alt: { gl: "Foto 1 (gl)", es: "Foto 1 (es)" },
        width: 1500,
        height: 1000,
      });
      await assert.rejects(
        addCatalogPhoto(
          domain,
          actor("admin"),
          tenantId,
          "facility",
          facilityId,
          { image, alt: alt("Séptima") },
        ),
        { code: "PHOTO_LIMIT_REACHED" },
      );
      const stored = await catalogPhotoContent(
        domain,
        actor("admin"),
        tenantId,
        "facility",
        facilityId,
        ids[0] ?? "",
        "large",
      );
      const metadata = await sharp(stored).metadata();
      assert.equal(metadata.format, "webp");
      assert.equal(metadata.exif, undefined);
      // The uploaded file itself is never kept.
      const columns = await migration.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema='domain' AND table_name='catalog_photo' AND data_type='bytea' ORDER BY column_name",
      );
      assert.deepEqual(
        columns.rows.map((row) => row.column_name),
        ["large", "small"],
      );
    });

    await test("input is validated before anything is stored", async () => {
      for (const input of [
        { image, alt: { gl: "Só galego", es: "  " } },
        { image, alt: { gl: "x".repeat(251), es: "Válida" } },
      ])
        await assert.rejects(
          addCatalogPhoto(
            domain,
            actor("admin"),
            tenantId,
            "unit",
            unitId,
            input,
          ),
          { code: "INVALID_INPUT" },
        );
      for (const bad of [
        "no es base64!",
        Buffer.from("texto").toString("base64"),
      ])
        await assert.rejects(
          addCatalogPhoto(domain, actor("admin"), tenantId, "unit", unitId, {
            image: bad,
            alt: alt("Mala"),
          }),
          { code: "PHOTO_INVALID" },
        );
      await assert.rejects(
        addCatalogPhoto(
          domain,
          actor("admin", false),
          tenantId,
          "unit",
          unitId,
          { image, alt: alt("Sen MFA") },
        ),
        { code: "REAUTHENTICATION_REQUIRED" },
      );
    });

    await test("a scoped manager maintains the photos of its unit only", async () => {
      const added = await addCatalogPhoto(
        domain,
        actor("manager"),
        tenantId,
        "unit",
        unitId,
        { image, alt: alt("Pista") },
      );
      assert.equal(added.photos.length, 1);
      await assert.rejects(
        addCatalogPhoto(domain, actor("manager"), tenantId, "unit", otherUnit, {
          image,
          alt: alt("Allea"),
        }),
        { code: "FORBIDDEN" },
      );
      await assert.rejects(
        removeCatalogPhoto(
          domain,
          actor("manager"),
          tenantId,
          "facility",
          facilityId,
          ids[0] ?? "",
        ),
        { code: "FORBIDDEN" },
      );
      // Neither the manager nor another municipality can read facility photos.
      await assert.rejects(
        catalogPhotoContent(
          domain,
          actor("manager"),
          tenantId,
          "facility",
          facilityId,
          ids[0] ?? "",
          "small",
        ),
        { code: "NOT_FOUND" },
      );
      await assert.rejects(
        catalogPhotoContent(
          domain,
          actor("other-admin"),
          otherTenant,
          "facility",
          facilityId,
          ids[0] ?? "",
          "small",
        ),
        { code: "NOT_FOUND" },
      );
      // A photo is addressed through its own resource.
      await assert.rejects(
        describeCatalogPhoto(
          domain,
          actor("admin"),
          tenantId,
          "unit",
          unitId,
          ids[0] ?? "",
          { alt: alt("Cruzada") },
        ),
        { code: "NOT_FOUND" },
      );
    });

    await test("reorder accepts only the complete current list and removal closes the gap", async () => {
      const reversed = [...ids].reverse();
      const ordered = await orderCatalogPhotos(
        domain,
        actor("admin"),
        tenantId,
        "facility",
        facilityId,
        reversed,
      );
      assert.deepEqual(
        ordered.photos.map((photo) => photo.id),
        reversed,
      );
      await assert.rejects(
        orderCatalogPhotos(
          domain,
          actor("admin"),
          tenantId,
          "facility",
          facilityId,
          reversed.slice(1),
        ),
        { code: "STALE_VERSION" },
      );
      await assert.rejects(
        orderCatalogPhotos(
          domain,
          actor("admin"),
          tenantId,
          "facility",
          facilityId,
          [reversed[0] ?? "", reversed[0] ?? ""],
        ),
        { code: "INVALID_INPUT" },
      );
      const removed = await removeCatalogPhoto(
        domain,
        actor("admin"),
        tenantId,
        "facility",
        facilityId,
        reversed[0] ?? "",
      );
      assert.deepEqual(
        removed.photos.map((photo) => photo.id),
        reversed.slice(1),
      );
      const positions = await migration.query<{ position: number }>(
        "SELECT position FROM domain.catalog_photo WHERE tenant_id=$1 AND facility_id=$2 AND unit_id IS NULL ORDER BY position",
        [tenantId, facilityId],
      );
      assert.deepEqual(
        positions.rows.map((row) => row.position),
        [1, 2, 3, 4, 5],
      );
      const described = await describeCatalogPhoto(
        domain,
        actor("admin"),
        tenantId,
        "facility",
        facilityId,
        reversed[1] ?? "",
        { alt: { gl: "Entrada principal", es: "Entrada principal" } },
      );
      assert.equal(described.photos[0]?.alt.es, "Entrada principal");
      const events = await migration.query<{ action: string; count: number }>(
        "SELECT action,count(*)::int AS count FROM domain.catalog_photo_event WHERE tenant_id=$1 GROUP BY action ORDER BY action",
        [tenantId],
      );
      assert.deepEqual(
        Object.fromEntries(events.rows.map((row) => [row.action, row.count])),
        { ADDED: 7, DESCRIBED: 1, MOVED: 6, REMOVED: 1 },
      );
    });

    await test("public reads show photos only while their resources are published", async () => {
      const cover = (await publicFacilities(domain, tenantId)).items[0]
        ?.photos[0];
      assert.equal(cover?.alt.es, "Entrada principal");
      const units = await publicUnits(domain, tenantId, facilityId);
      assert.equal(
        units.items.find((unit) => unit.id === unitId)?.photos.length,
        1,
      );
      assert.equal(
        units.items.find((unit) => unit.id === otherUnit)?.photos.length,
        0,
      );
      const detail = await publicUnitDetail(domain, tenantId, unitId);
      assert.equal(detail.photos.length, 1);
      assert.equal(detail.facilityPhotos.length, 5);
      const unitPhoto = detail.photos[0]?.id ?? "";
      assert.ok(
        (await publicPhotoContent(domain, tenantId, unitPhoto, "small")).length,
      );
      await assert.rejects(
        publicPhotoContent(domain, otherTenant, unitPhoto, "small"),
        { code: "NOT_FOUND" },
      );
      await migration.query(
        "UPDATE domain.reservable_unit SET withdrawn_at=now() WHERE tenant_id=$1 AND id=$2",
        [tenantId, unitId],
      );
      await assert.rejects(
        publicPhotoContent(domain, tenantId, unitPhoto, "large"),
        { code: "NOT_FOUND" },
      );
      await migration.query(
        "UPDATE domain.reservable_unit SET withdrawn_at=NULL WHERE tenant_id=$1 AND id=$2",
        [tenantId, unitId],
      );
      const draft = await addCatalogPhoto(
        domain,
        actor("admin"),
        tenantId,
        "facility",
        draftFacility,
        { image, alt: alt("Borrador") },
      );
      await assert.rejects(
        publicPhotoContent(
          domain,
          tenantId,
          draft.photos[0]?.id ?? "",
          "small",
        ),
        { code: "NOT_FOUND" },
      );
    });

    await test("HTTP uploads, serves and revalidates photos", async () => {
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
        { origin: "https://quenda.test", secret: "photo-test-secret" },
      );
      try {
        const base = `/api/municipalities/${tenantId}/units/${otherUnit}/photos`;
        const added = await app.inject({
          method: "POST",
          url: base,
          headers: { origin: "https://quenda.test" },
          payload: { image, alt: alt("Pista 2") },
        });
        assert.equal(added.statusCode, 200, added.body);
        const photo = added.json().photos[0];
        assert.equal(photo.width, 1500);
        const invalid = await app.inject({
          method: "POST",
          url: base,
          headers: {
            origin: "https://quenda.test",
            "accept-language": "gl",
          },
          payload: {
            image: Buffer.from("<svg/>".repeat(4)).toString("base64"),
            alt: alt("SVG"),
          },
        });
        assert.equal(invalid.statusCode, 400);
        assert.equal(invalid.json().error.code, "PHOTO_INVALID");
        assert.match(invalid.json().error.message, /foto horizontal/);
        const editor = await app.inject({ url: `${base}/${photo.id}/small` });
        assert.equal(editor.statusCode, 200);
        assert.equal(editor.headers["content-type"], "image/webp");
        assert.equal(editor.headers["cache-control"], "private, max-age=3600");
        const url = `/api/public/municipalities/${tenantId}/photos/${photo.id}/large`;
        const served = await app.inject({ url });
        assert.equal(served.statusCode, 200);
        assert.equal(served.headers["content-type"], "image/webp");
        assert.equal(served.headers["cache-control"], "public, max-age=3600");
        assert.equal(
          (await sharp(served.rawPayload).metadata()).width,
          photo.width,
        );
        const revalidated = await app.inject({
          url,
          headers: { "if-none-match": String(served.headers.etag) },
        });
        assert.equal(revalidated.statusCode, 304);
        assert.equal(revalidated.rawPayload.length, 0);
        assert.equal(
          (
            await app.inject({
              url: `/api/public/municipalities/${tenantId}/photos/${photo.id}/original`,
            })
          ).statusCode,
          400,
        );
        const facility = await app.inject({
          url: `/api/public/municipalities/${tenantId}/units/${otherUnit}`,
        });
        assert.equal(facility.json().photos[0].id, photo.id);
        assert.equal(facility.json().facilityPhotos.length, 5);
        const removed = await app.inject({
          method: "DELETE",
          url: `${base}/${photo.id}`,
          headers: { origin: "https://quenda.test" },
        });
        assert.deepEqual(removed.json(), { photos: [] });
        assert.equal((await app.inject({ url })).statusCode, 404);
      } finally {
        await app.close();
      }
    });
  });
});
