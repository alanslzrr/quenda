import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import Fastify from "fastify";
import sharp from "sharp";
import { initializeOperator } from "../../scripts/lib/initialize-operator.ts";
import { registerErrors } from "../../src/http/errors.ts";
import type { Authentication } from "../../src/modules/identity/auth.ts";
import {
  publicBranding,
  removeLogo,
  renameMunicipality,
  saveLogo,
} from "../../src/modules/identity/branding.ts";
import { registerBrandingRoutes } from "../../src/modules/identity/branding-routes.ts";
import {
  acceptAdministratorInvitation,
  createMunicipality,
} from "../../src/modules/identity/municipality.ts";
import { publicMunicipalities } from "../../src/modules/identity/navigation.ts";
import { withDatabase } from "../helpers/postgres.ts";

const image = (width: number, height: number, format: "png" | "jpeg") =>
  sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 20, g: 80, b: 160, alpha: format === "png" ? 0.5 : 1 },
    },
  })
    [format]()
    .toBuffer()
    .then((buffer) => buffer.toString("base64"));

test("municipal name and logo are administrator-only, validated, re-encoded, versioned and audited", {
  timeout: 60000,
}, async () => {
  await withDatabase(async ({ domain, auth, migration, worker }) => {
    const actor = (id: string) => ({
      accountId: id,
      email: `${id}@example.test`,
      sessionId: id,
      mfaVerifiedAt: new Date(),
    });
    for (const id of ["operator", "admin", "outsider"])
      await auth.query(
        'INSERT INTO auth."user"(id,name,email,"emailVerified","createdAt","updatedAt","twoFactorEnabled") VALUES($1,$1,$2,true,now(),now(),true)',
        [id, `${id}@example.test`],
      );
    const owner = await migration.connect();
    try {
      await initializeOperator(owner, "operator");
    } finally {
      owner.release();
    }
    const create = async (name: string) => {
      const item = await createMunicipality(domain, actor("operator"), {
        name,
        timezone: "Europe/Madrid",
        administratorEmail: "admin@example.test",
        invitationExpiresAt: new Date(Date.now() + 3600000).toISOString(),
      });
      await acceptAdministratorInvitation(
        domain,
        actor("admin"),
        item.tenantId,
        item.invitationId,
      );
      return item.tenantId;
    };
    const tenantId = await create("Concello de Valdeira");
    const other = await create("Concello de Outeiro");
    assert.deepEqual(await publicBranding(domain, tenantId), {
      version: 1,
      name: "Concello de Valdeira",
      officialName: "Concello de Valdeira",
      logos: { light: false, dark: false },
    });

    // Only the administrator with recent MFA changes the name.
    for (const account of [
      actor("operator"),
      actor("outsider"),
      { ...actor("admin"), mfaVerifiedAt: null },
    ])
      await assert.rejects(
        renameMunicipality(
          domain,
          account,
          tenantId,
          { expectedVersion: 1, name: "Valdeira" },
          randomUUID(),
        ),
      );
    for (const name of ["", "   ", "Val\u0007deira", "x".repeat(121)])
      await assert.rejects(
        renameMunicipality(
          domain,
          actor("admin"),
          tenantId,
          { expectedVersion: 1, name },
          randomUUID(),
        ),
        { code: "INVALID_INPUT" },
      );
    const renamed = await renameMunicipality(
      domain,
      actor("admin"),
      tenantId,
      { expectedVersion: 1, name: "  Concello   de Valdeira  · Turismo " },
      randomUUID(),
    );
    assert.equal(renamed.version, 2);
    assert.equal(renamed.name, "Concello de Valdeira · Turismo");
    assert.equal(renamed.officialName, "Concello de Valdeira");
    // The visible name is the one every other query reads.
    assert.equal(
      (
        await migration.query(
          "SELECT name FROM domain.municipality WHERE id=$1",
          [tenantId],
        )
      ).rows[0].name,
      "Concello de Valdeira · Turismo",
    );
    await assert.rejects(
      renameMunicipality(
        domain,
        actor("admin"),
        tenantId,
        { expectedVersion: 1, name: "Otro" },
        randomUUID(),
      ),
      { code: "STALE_VERSION" },
    );

    // Logos: raster only, re-encoded as WebP within 512 px, dark only after the main one.
    const png = await image(1600, 400, "png");
    await assert.rejects(
      saveLogo(
        domain,
        actor("admin"),
        tenantId,
        "dark",
        { expectedVersion: 2, image: png },
        randomUUID(),
      ),
      { code: "INVALID_INPUT" },
    );
    for (const invalid of [
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      ).toString("base64"),
      await image(20, 20, "png"),
      await image(1000, 200, "png"),
      Buffer.from("not an image at all").toString("base64"),
    ])
      await assert.rejects(
        saveLogo(
          domain,
          actor("admin"),
          tenantId,
          "light",
          { expectedVersion: 2, image: invalid },
          randomUUID(),
        ),
        { code: "LOGO_INVALID" },
      );
    await assert.rejects(
      saveLogo(
        domain,
        actor("outsider"),
        tenantId,
        "light",
        { expectedVersion: 2, image: png },
        randomUUID(),
      ),
    );
    const withLogo = await saveLogo(
      domain,
      actor("admin"),
      tenantId,
      "light",
      { expectedVersion: 2, image: png },
      randomUUID(),
    );
    assert.deepEqual(withLogo.logos, { light: true, dark: false });
    const stored = (
      await migration.query(
        "SELECT width,height,image FROM domain.municipal_logo WHERE tenant_id=$1",
        [tenantId],
      )
    ).rows[0];
    assert.deepEqual([stored.width, stored.height], [512, 128]);
    const metadata = await sharp(stored.image).metadata();
    assert.equal(metadata.format, "webp");
    assert.equal(metadata.hasAlpha, true);
    assert.equal(metadata.exif, undefined);
    const dark = await saveLogo(
      domain,
      actor("admin"),
      tenantId,
      "dark",
      { expectedVersion: 3, image: await image(300, 300, "jpeg") },
      randomUUID(),
    );
    assert.deepEqual(dark.logos, { light: true, dark: true });
    // The public municipality record carries the same branding state, so pages need no extra request.
    assert.deepEqual(
      (await publicMunicipalities(domain, null, tenantId)).items[0],
      {
        id: tenantId,
        name: "Concello de Valdeira · Turismo",
        timeZone: "Europe/Madrid",
        officialName: "Concello de Valdeira",
        branding: { version: 4, logos: { light: true, dark: true } },
      },
    );
    assert.deepEqual((await publicBranding(domain, other)).logos, {
      light: false,
      dark: false,
    });

    // The database keeps logos and history out of every application role's direct reach.
    for (const pool of [domain, auth, worker]) {
      await assert.rejects(pool.query("SELECT * FROM domain.municipal_logo"), {
        code: "42501",
      });
      await assert.rejects(
        pool.query("SELECT * FROM domain.municipal_branding_event"),
        { code: "42501" },
      );
    }
    await assert.rejects(
      domain.query("UPDATE domain.municipality SET name='x' WHERE id=$1", [
        tenantId,
      ]),
      { code: "42501" },
    );

    const app = Fastify({
      genReqId: () => randomUUID(),
      ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
    });
    registerErrors(app);
    await registerBrandingRoutes(
      app,
      domain,
      { authenticate: async () => actor("admin") } as unknown as Authentication,
      { origin: "https://quenda.test", secret: "branding-test-secret" },
    );
    try {
      const logo = await app.inject(
        `/api/public/municipalities/${tenantId}/logo/light`,
      );
      assert.equal(logo.statusCode, 200);
      assert.equal(logo.headers["content-type"], "image/webp");
      const again = await app.inject({
        url: `/api/public/municipalities/${tenantId}/logo/light`,
        headers: { "if-none-match": String(logo.headers.etag) },
      });
      assert.equal(again.statusCode, 304);
      assert.equal(
        (await app.inject(`/api/public/municipalities/${other}/logo/light`))
          .statusCode,
        404,
      );
      assert.equal(
        (await app.inject(`/api/public/municipalities/${tenantId}/logo/svg`))
          .statusCode,
        400,
      );
      const request = (
        method: "PUT" | "DELETE",
        url: string,
        payload?: object,
      ) =>
        app.inject({
          method,
          url,
          headers: { origin: "https://quenda.test" },
          ...(payload ? { payload } : {}),
        });
      assert.equal(
        (
          await request(
            "PUT",
            `/api/municipalities/${tenantId}/branding/name`,
            { expectedVersion: 4, name: "Valdeira", css: "x" },
          )
        ).statusCode,
        400,
      );
      // Removing the main logo removes its dark version too.
      const removed = await request(
        "DELETE",
        `/api/municipalities/${tenantId}/branding/logos/light?expectedVersion=4`,
      );
      assert.equal(removed.statusCode, 200, removed.body);
      assert.deepEqual(removed.json().logos, { light: false, dark: false });
      assert.equal(
        (
          await request(
            "DELETE",
            `/api/municipalities/${tenantId}/branding/logos/light?expectedVersion=5`,
          )
        ).statusCode,
        404,
      );
    } finally {
      await app.close();
    }
    await assert.rejects(
      removeLogo(domain, actor("admin"), tenantId, "light", 4, randomUUID()),
      { code: "STALE_VERSION" },
    );

    const events = (
      await migration.query(
        "SELECT version,action,previous_state,next_state FROM domain.municipal_branding_event WHERE tenant_id=$1 ORDER BY version",
        [tenantId],
      )
    ).rows;
    assert.deepEqual(
      events.map((e) => [e.version, e.action]),
      [
        [2, "RENAMED"],
        [3, "LOGO_SET"],
        [4, "LOGO_SET"],
        [5, "LOGO_REMOVED"],
      ],
    );
    assert.equal(events[0].previous_state.name, "Concello de Valdeira");
    assert.deepEqual(events[1].previous_state.logos, {});
    assert.deepEqual(Object.keys(events[2].next_state.logos).sort(), [
      "dark",
      "light",
    ]);
    assert.deepEqual(events[3].next_state.logos, {});
  });
});
