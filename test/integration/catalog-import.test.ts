import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { buildApp } from "../../src/app.ts";
import { createAuthentication } from "../../src/modules/identity/index.ts";
import { browser, totp } from "../helpers/auth-client.ts";
import { withDatabase } from "../helpers/postgres.ts";
import { verifyProductResponses } from "../helpers/response-contract.ts";
import { seedMunicipalBrowser } from "../helpers/web-municipal.ts";

test("an exported catalog loads into an empty municipality as drafts and exports back the same", {
  timeout: 60000,
}, async () => {
  await withDatabase(async ({ auth, domain, migration }) => {
    const config = {
      origin: "http://127.0.0.1:5173",
      secret: randomBytes(32).toString("hex"),
    };
    const app = await buildApp({
      database: { check: async () => {}, close: async () => {} },
      domain,
      logLevel: "silent",
      identity: {
        config,
        authentication: createAuthentication(auth, config, {
          send: async () => {},
        }),
      },
    });
    const contract = verifyProductResponses(app);
    try {
      const f = await seedMunicipalBrowser(app, auth, domain, migration, 1);
      const other = await seedMunicipalBrowser(app, auth, domain, migration, 2);
      // Source details: a full facility profile, a unit profile and a withdrawn unit.
      await migration.query(
        "UPDATE domain.facility SET address='Rúa do Porto 3',postal_code='15179',latitude=43.3389,longitude=-8.3463,description_gl='Pavillón',description_es='Pabellón',contact_phone='981000000',profile_version=1 WHERE tenant_id=$1 AND id=$2",
        [f.tenant, f.facility],
      );
      await migration.query(
        "UPDATE domain.reservable_unit SET kind='padel',indoor=true,capacity=4,description_es='Pista cubierta',profile_version=1 WHERE tenant_id=$1 AND id=$2",
        [f.tenant, f.unit],
      );
      await migration.query(
        "INSERT INTO domain.reservable_unit(tenant_id,id,facility_id,name,withdrawn_at) VALUES($1,$2,$3,'Pista antigua',now())",
        [f.tenant, randomUUID(), f.facility],
      );
      // An empty target municipality administered by the same account.
      const target = randomUUID();
      await migration.query(
        "INSERT INTO domain.municipality(id,name,timezone) VALUES($1,'Destino','Europe/Madrid')",
        [target],
      );
      const invitation = randomUUID();
      await migration.query(
        "INSERT INTO domain.municipal_profile(tenant_id,account_id) VALUES($1,$2)",
        [target, f.accountId],
      );
      await migration.query(
        "INSERT INTO domain.administrator_invitation(tenant_id,id,account_id,invited_by,expires_at,accepted_at) VALUES($1,$2,$3,$3,now()+interval '1 day',now())",
        [target, invitation, f.accountId],
      );
      await migration.query(
        "INSERT INTO domain.municipal_administrator(tenant_id,account_id,invitation_id) VALUES($1,$2,$3)",
        [target, f.accountId, invitation],
      );
      const admin = browser(app, "192.0.2.170", config.origin);
      await admin.request("/api/auth/sign-in/email", {
        email: f.email,
        password: f.password,
      });
      await admin.request("/api/auth/two-factor/verify-totp", {
        code: totp(f.secret),
      });
      const exported = await admin.request(
        `/api/municipalities/${f.tenant}/exports/catalog`,
      );
      assert.equal(exported.statusCode, 200, exported.body);
      const document = exported.json();
      const load = (tenant: string, body: unknown, key = randomUUID()) =>
        admin.request(
          `/api/municipalities/${tenant}/imports/catalog`,
          body as Record<string, unknown>,
          { "idempotency-key": key },
        );
      // Compares what an import must carry over: everything but identifiers,
      // publication state and municipal settings.
      const shape = (catalog: typeof document) => {
        const names = new Map(
          catalog.facilities.map((x: { id: string; name: string }) => [
            x.id,
            x.name,
          ]),
        );
        return {
          facilities: catalog.facilities
            .filter((x: { withdrawnAt: string | null }) => !x.withdrawnAt)
            .map((x: { name: string; profile: unknown }) => ({
              name: x.name,
              profile: x.profile,
            })),
          units: catalog.units
            .filter((x: { withdrawnAt: string | null }) => !x.withdrawnAt)
            .map(
              (x: {
                facilityId: string;
                name: string;
                profile: unknown;
                calendar: { version: number } | null;
                usageRules: { text: string } | null;
              }) => ({
                facility: names.get(x.facilityId),
                name: x.name,
                profile: x.profile,
                calendar: x.calendar && { ...x.calendar, version: 1 },
                usageRules: x.usageRules?.text ?? null,
              }),
            ),
        };
      };

      const key = randomUUID();
      await test("an empty municipality receives drafts with new identifiers", async () => {
        const response = await load(target, document, key);
        assert.equal(response.statusCode, 200, response.body);
        assert.deepEqual(response.json(), {
          tenantId: target,
          facilities: 1,
          units: 2,
          calendars: 2,
          usageRules: 2,
          skippedWithdrawn: 1,
        });
        const copy = (
          await admin.request(`/api/municipalities/${target}/exports/catalog`)
        ).json();
        assert.deepEqual(shape(copy), shape(document));
        for (const resource of [...copy.facilities, ...copy.units]) {
          assert.equal(resource.publishedAt, null);
          assert.ok(
            ![...document.facilities, ...document.units].some(
              (source: { id: string }) => source.id === resource.id,
            ),
          );
        }
        const audit = await migration.query(
          "SELECT (SELECT count(*) FROM domain.catalog_event WHERE tenant_id=$1)::int AS created,(SELECT count(*) FROM domain.catalog_profile_event WHERE tenant_id=$1)::int AS profiles",
          [target],
        );
        // Two non-empty profiles (the facility and one unit) become version 2.
        assert.deepEqual(audit.rows[0], { created: 3, profiles: 2 });
      });

      await test("a retried request returns the same result; a new one finds the catalog in use", async () => {
        const again = await load(target, document, key);
        assert.equal(again.statusCode, 200, again.body);
        assert.equal(again.json().units, 2);
        assert.equal(
          (
            await migration.query(
              "SELECT count(*)::int AS n FROM domain.facility WHERE tenant_id=$1",
              [target],
            )
          ).rows[0].n,
          1,
        );
        assert.equal((await load(target, document)).statusCode, 409);
      });

      await test("malformed documents change nothing", async () => {
        const empty = randomUUID();
        await migration.query(
          "INSERT INTO domain.municipality(id,name,timezone) VALUES($1,'Vacío','Europe/Madrid')",
          [empty],
        );
        const invitationId = randomUUID();
        await migration.query(
          "INSERT INTO domain.municipal_profile(tenant_id,account_id) VALUES($1,$2)",
          [empty, f.accountId],
        );
        await migration.query(
          "INSERT INTO domain.administrator_invitation(tenant_id,id,account_id,invited_by,expires_at,accepted_at) VALUES($1,$2,$3,$3,now()+interval '1 day',now())",
          [empty, invitationId, f.accountId],
        );
        await migration.query(
          "INSERT INTO domain.municipal_administrator(tenant_id,account_id,invitation_id) VALUES($1,$2,$3)",
          [empty, f.accountId, invitationId],
        );
        const orphan = structuredClone(document);
        orphan.units[0].facilityId = randomUUID();
        const badCalendar = structuredClone(document);
        badCalendar.units[0].calendar.stepMinutes = 7;
        for (const body of [
          { ...document, format: "other" },
          orphan,
          badCalendar,
        ])
          assert.equal((await load(empty, body)).statusCode, 400);
        assert.equal(
          (
            await migration.query(
              "SELECT count(*)::int AS n FROM domain.facility WHERE tenant_id=$1",
              [empty],
            )
          ).rows[0].n,
          0,
        );
      });

      await test("only the target's administrator with recent MFA and the configured origin can import", async () => {
        const outsider = browser(app, "192.0.2.171", config.origin);
        await outsider.request("/api/auth/sign-in/email", {
          email: other.email,
          password: other.password,
        });
        await outsider.request("/api/auth/two-factor/verify-totp", {
          code: totp(other.secret),
        });
        assert.equal(
          (
            await outsider.request(
              `/api/municipalities/${target}/imports/catalog`,
              document,
            )
          ).statusCode,
          403,
        );
        const forged = browser(app, "192.0.2.172", "https://elsewhere.test");
        assert.equal(
          (
            await forged.request(
              `/api/municipalities/${target}/imports/catalog`,
              document,
            )
          ).statusCode,
          403,
        );
      });
      contract.assertValid();
    } finally {
      await app.close();
    }
  });
});
