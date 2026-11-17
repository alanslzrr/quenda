import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import swagger from "@fastify/swagger";
import Fastify from "fastify";
import { initializeOperator } from "../../scripts/lib/initialize-operator.ts";
import { transaction } from "../../src/database/transaction.ts";
import { registerErrors } from "../../src/http/errors.ts";
import type { Authentication } from "../../src/modules/identity/auth.ts";
import {
  acceptManager,
  inviteManager,
} from "../../src/modules/identity/manager.ts";
import {
  acceptAdministratorInvitation,
  createMunicipality,
} from "../../src/modules/identity/municipality.ts";
import {
  exportGlobalPersonalData,
  exportMunicipalPersonalData,
  exportOwnPersonalData,
} from "../../src/modules/identity/personal-data.ts";
import { registerPersonalDataRoutes } from "../../src/modules/identity/personal-data-routes.ts";
import {
  acceptGlobalPrivacy,
  inviteGlobalPrivacy,
} from "../../src/modules/identity/privacy-permissions.ts";
import { createReservation } from "../../src/modules/reservations/index.ts";
import { withDatabase } from "../helpers/postgres.ts";
import { verifyProductResponses } from "../helpers/response-contract.ts";
import {
  initialAcceptance,
  seedUsageRules,
} from "../helpers/usage-rules-fixture.ts";

const actor = (id: string, mfa = true) => ({
  accountId: id,
  email: `${id}@example.test`,
  sessionId: `session-${id}`,
  mfaVerifiedAt: mfa ? new Date() : null,
});
const expiry = () => new Date(Date.now() + 3_600_000).toISOString();
const authorization = {
  reason: "Respuesta autorizada al interesado",
  authorizationReference: "Referencia administrativa externa 123",
};

test("personal data access is self-service or explicitly scoped, bounded and audited", {
  timeout: 60000,
}, async (t) => {
  await withDatabase(async ({ domain, auth, migration }) => {
    for (const id of [
      "operator",
      "admin",
      "reader",
      "global-reader",
      "citizen",
      "other",
      "exporter",
    ])
      await auth.query(
        'INSERT INTO auth."user"(id,name,email,"emailVerified","updatedAt","twoFactorEnabled") VALUES($1,$1,$2,true,now(),$3)',
        [id, `${id}@example.test`, !["citizen", "other"].includes(id)],
      );
    await auth.query(
      "INSERT INTO auth.account(id,\"accountId\",\"providerId\",\"userId\",password,\"accessToken\",\"refreshToken\",\"updatedAt\") VALUES('credential-citizen','external-citizen','credential','citizen','SECRET_PASSWORD_HASH','SECRET_ACCESS_TOKEN','SECRET_REFRESH_TOKEN',now())",
    );
    await auth.query(
      "INSERT INTO auth.session(id,\"expiresAt\",token,\"userId\",\"updatedAt\",\"ipAddress\",\"userAgent\") VALUES('session-citizen',now()+interval '1 day','SECRET_SESSION_TOKEN','citizen',now(),'192.0.2.15','Synthetic user agent')",
    );
    const client = await migration.connect();
    try {
      await initializeOperator(client, "operator");
    } finally {
      client.release();
    }
    const tenantIds: string[] = [];
    for (const name of ["A Coruña", "Oleiros"]) {
      const municipality = await createMunicipality(domain, actor("operator"), {
        name,
        timezone: "Europe/Madrid",
        administratorEmail: "admin@example.test",
        invitationExpiresAt: expiry(),
      });
      await acceptAdministratorInvitation(
        domain,
        actor("admin"),
        municipality.tenantId,
        municipality.invitationId,
      );
      tenantIds.push(municipality.tenantId);
    }
    const [first, second] = tenantIds as [string, string];
    const units: string[] = [];
    for (const tenant of tenantIds) {
      const facility = randomUUID(),
        unit = randomUUID();
      units.push(unit);
      await migration.query(
        "INSERT INTO domain.facility(tenant_id,id,name,published_at) VALUES($1,$2,'Pabellón',now())",
        [tenant, facility],
      );
      await migration.query(
        "INSERT INTO domain.reservable_unit(tenant_id,id,facility_id,name) VALUES($1,$2,$3,'Pista')",
        [tenant, unit, facility],
      );
      await migration.query(
        "INSERT INTO domain.unit_calendar_version(tenant_id,unit_id,version,minimum_minutes,maximum_minutes,step_minutes,weekly,exceptions,actor_id,reason) VALUES($1,$2,1,60,60,60,$3,'[]','admin','Fixture')",
        [
          tenant,
          unit,
          JSON.stringify(
            Array.from({ length: 7 }, (_, i) => ({
              day: i + 1,
              startMinute: 0,
              endMinute: 1440,
            })),
          ),
        ],
      );
      await seedUsageRules(migration, tenant, unit, "admin");
      await migration.query(
        "UPDATE domain.reservable_unit SET calendar_version=1,published_at=now() WHERE tenant_id=$1 AND id=$2",
        [tenant, unit],
      );
      const start = new Date();
      start.setUTCDate(start.getUTCDate() + 3);
      start.setUTCHours(12, 0, 0, 0);
      for (const [index, user] of ["citizen", "other"].entries()) {
        const startsAt = new Date(
          start.getTime() + index * 3600000,
        ).toISOString();
        const endsAt = new Date(
          start.getTime() + (index + 1) * 3600000,
        ).toISOString();
        await createReservation(
          domain,
          actor(user, false),
          tenant,
          randomUUID(),
          { unitId: unit, startsAt, endsAt, acceptance: initialAcceptance },
          randomUUID(),
          3600,
        );
      }
    }
    const municipalGrant = await inviteManager(domain, actor("admin"), first, {
      email: "reader@example.test",
      expiresAt: expiry(),
      permissions: [{ operation: "PRIVACY_READ", unitId: null }],
    });
    await acceptManager(
      domain,
      actor("reader"),
      first,
      municipalGrant.invitationId,
    );
    const exportGrant = await inviteManager(domain, actor("admin"), first, {
      email: "exporter@example.test",
      expiresAt: expiry(),
      permissions: [
        { operation: "DATA_EXPORT", unitId: null },
        { operation: "RESERVATION_READ", unitId: null },
      ],
    });
    await acceptManager(
      domain,
      actor("exporter"),
      first,
      exportGrant.invitationId,
    );
    const globalGrant = await inviteGlobalPrivacy(domain, actor("operator"), {
      email: "global-reader@example.test",
      permissions: ["PRIVACY_READ"],
      expiresAt: expiry(),
      reason: "Global privacy access",
    });
    await acceptGlobalPrivacy(
      domain,
      actor("global-reader"),
      globalGrant.invitationId,
    );

    await t.test(
      "self export combines only the holder's municipalities and never credential material",
      async () => {
        const result = await exportOwnPersonalData(
          domain,
          actor("citizen", false),
          randomUUID(),
        );
        assert.equal(result.format, "quenda.personal-data");
        assert.equal(result.version, 1);
        assert.equal(result.completeness.status, "PARTIAL");
        assert.equal(result.completeness.legalAccessResponseComplete, false);
        assert.deepEqual(
          new Set(
            result.records
              .filter((r) => r.type === "reservation")
              .map((r) => r.tenantId),
          ),
          new Set(tenantIds),
        );
        assert.equal(
          result.records.filter((r) => r.type === "reservation").length,
          2,
        );
        assert.equal(
          result.records.find((r) => r.type === "account")?.data.email,
          "citizen@example.test",
        );
        assert.equal(
          result.records.find((r) => r.type === "session")?.data.ipAddress,
          "192.0.2.15",
        );
        assert.equal(
          result.records.find((r) => r.type === "reservation")?.data
            .acceptedUsageRulesText,
          "Synthetic fixture rules",
        );
        const serialized = JSON.stringify(result);
        for (const secret of [
          "SECRET_PASSWORD_HASH",
          "SECRET_ACCESS_TOKEN",
          "SECRET_REFRESH_TOKEN",
          "SECRET_SESSION_TOKEN",
          "external-citizen",
          "other@example.test",
        ])
          assert.equal(serialized.includes(secret), false, secret);
        assert.equal(
          result.records.some((r) => r.type === "reservationEvent"),
          true,
        );
        assert.equal(
          result.records.some((r) => r.type === "reservationNotice"),
          true,
        );
      },
    );
    await t.test(
      "administrators, operators and data exporters get no implicit privacy permission",
      async () => {
        for (const id of ["admin", "operator", "exporter"])
          await assert.rejects(
            exportMunicipalPersonalData(
              domain,
              actor(id),
              first,
              "citizen",
              authorization,
              randomUUID(),
            ),
            { code: "FORBIDDEN" },
          );
        await assert.rejects(
          exportGlobalPersonalData(
            domain,
            actor("operator"),
            "citizen",
            authorization,
            randomUUID(),
          ),
          { code: "FORBIDDEN" },
        );
        await assert.rejects(
          exportMunicipalPersonalData(
            domain,
            actor("reader"),
            second,
            "citizen",
            authorization,
            randomUUID(),
          ),
          { code: "FORBIDDEN" },
        );
        await assert.rejects(
          exportGlobalPersonalData(
            domain,
            actor("reader"),
            "citizen",
            authorization,
            randomUUID(),
          ),
          { code: "FORBIDDEN" },
        );
        await assert.rejects(
          exportMunicipalPersonalData(
            domain,
            actor("global-reader"),
            first,
            "citizen",
            authorization,
            randomUUID(),
          ),
          { code: "FORBIDDEN" },
        );
      },
    );
    await t.test(
      "municipal exports omit global identity and the other municipality",
      async () => {
        const result = await exportMunicipalPersonalData(
          domain,
          actor("reader"),
          first,
          "citizen",
          authorization,
          randomUUID(),
        );
        assert.ok(result.records.length > 0);
        assert.ok(result.records.every((r) => r.tenantId === first));
        assert.equal(
          JSON.stringify(result).includes("citizen@example.test"),
          false,
        );
        assert.equal(JSON.stringify(result).includes(second), false);
        const global = await exportGlobalPersonalData(
          domain,
          actor("global-reader"),
          "citizen",
          authorization,
          randomUUID(),
        );
        assert.ok(global.records.every((r) => r.tenantId === null));
        assert.equal(
          global.records.some((r) => r.type === "reservation"),
          false,
        );
      },
    );
    await t.test(
      "recent MFA and external authorization are required for administrative preparation",
      async () => {
        await assert.rejects(
          exportMunicipalPersonalData(
            domain,
            {
              ...actor("reader"),
              mfaVerifiedAt: new Date(Date.now() - 300000),
            },
            first,
            "citizen",
            authorization,
            randomUUID(),
          ),
          { code: "REAUTHENTICATION_REQUIRED" },
        );
        await assert.rejects(
          exportMunicipalPersonalData(
            domain,
            actor("reader"),
            first,
            "citizen",
            { ...authorization, authorizationReference: " " },
            randomUUID(),
          ),
          { code: "INVALID_INPUT" },
        );
      },
    );
    await t.test(
      "inactive targets are accessible administratively without restoring account or roles",
      async () => {
        await migration.query(
          "UPDATE auth.account_lifecycle SET deactivated_at=clock_timestamp(),suspended_at=clock_timestamp() WHERE account_id='citizen'",
        );
        const result = await exportMunicipalPersonalData(
          domain,
          actor("reader"),
          first,
          "citizen",
          authorization,
          randomUUID(),
        );
        assert.ok(result.records.some((r) => r.type === "reservation"));
        const global = await exportGlobalPersonalData(
          domain,
          actor("global-reader"),
          "citizen",
          authorization,
          randomUUID(),
        );
        assert.ok(
          global.records.find((r) => r.type === "account")?.data.suspendedAt,
        );
        await assert.rejects(
          exportOwnPersonalData(domain, actor("citizen", false), randomUUID()),
          { code: "ACCOUNT_INACTIVE" },
        );
        await migration.query(
          "UPDATE auth.account_lifecycle SET deactivated_at=NULL,suspended_at=NULL WHERE account_id='citizen'",
        );
      },
    );
    await t.test(
      "administrative access identifies archived municipal data even after the ordinary profile was removed",
      async () => {
        await auth.query(
          `INSERT INTO auth."user"(id,name,email,"emailVerified","updatedAt") VALUES('archived','Archived user','archived@example.test',true,now())`,
        );
        const event = (
          await migration.query(
            "INSERT INTO domain.retention_event(operation,tenant_id,category,target_key,subject_id,action) VALUES('RETENTION_APPLIED',$1,'MUNICIPAL_PROFILE','archived','archived','BLOCK') RETURNING id",
            [first],
          )
        ).rows[0].id;
        await migration.query(
          "INSERT INTO domain.retention_archive(id,event_id,tenant_id,category,target_key,subject_id,payload,destroy_after) VALUES($1,$2,$3,'MUNICIPAL_PROFILE','archived','archived',$4,now()+interval '1 year')",
          [
            randomUUID(),
            event,
            first,
            { municipalProfile: { sensitive: "ARCHIVED_ONLY" } },
          ],
        );
        const result = await exportMunicipalPersonalData(
          domain,
          actor("reader"),
          first,
          "archived",
          authorization,
          randomUUID(),
        );
        assert.deepEqual(result.completeness.restrictedCategories, [
          { category: "MUNICIPAL_PROFILE", tenantId: first },
        ]);
        assert.equal(JSON.stringify(result).includes("ARCHIVED_ONLY"), false);
        assert.equal(
          result.records.some((r) => r.type === "municipalProfile"),
          false,
        );
      },
    );
    await t.test(
      "SQL entry points cannot bypass actor, tenant or audit and internal readers are unavailable",
      async () => {
        await assert.rejects(
          transaction(
            domain,
            (client) =>
              client.query(
                "SELECT domain.export_personal_data('other','SELF',NULL,NULL,NULL,$1)",
                [randomUUID()],
              ),
            { accountId: "citizen", tenantId: null },
          ),
          { code: "42501" },
        );
        await assert.rejects(
          transaction(
            domain,
            (client) =>
              client.query(
                "SELECT domain.export_personal_data('citizen','MUNICIPAL',$1,'reason','reference',$2)",
                [first, randomUUID()],
              ),
            { accountId: "reader", tenantId: second },
          ),
          { code: "42501" },
        );
        await assert.rejects(
          domain.query(
            "SELECT * FROM domain.personal_data_records('citizen',NULL,true,true)",
          ),
          { code: "42501" },
        );
        await assert.rejects(
          domain.query("SELECT * FROM domain.personal_data_access_event"),
          { code: "42501" },
        );
        const count = (
          await migration.query(
            "SELECT count(*)::int AS n FROM domain.personal_data_access_event",
          )
        ).rows[0].n;
        await assert.rejects(
          transaction(
            domain,
            async (client) => {
              await client.query(
                "SELECT domain.export_personal_data('citizen','SELF',NULL,NULL,NULL,$1)",
                [randomUUID()],
              );
              throw new Error("rollback fixture");
            },
            { accountId: "citizen", tenantId: null },
          ),
          /rollback fixture/,
        );
        assert.equal(
          (
            await migration.query(
              "SELECT count(*)::int AS n FROM domain.personal_data_access_event",
            )
          ).rows[0].n,
          count,
        );
        const audits = (
          await migration.query(
            "SELECT * FROM domain.personal_data_access_event WHERE access_mode='MUNICIPAL'",
          )
        ).rows;
        assert.ok(audits.length > 0);
        assert.ok(
          audits.every(
            (r) =>
              r.authorization_reference ===
              authorization.authorizationReference,
          ),
        );
      },
    );
    await t.test(
      "restricted categories are not disclosed and omission is explicit",
      async () => {
        const definition = (
          await migration.query(
            "SELECT pg_get_functiondef('domain.privacy_subject_restricted(uuid,text,text)'::regprocedure) AS sql",
          )
        ).rows[0].sql;
        try {
          await migration.query(
            "CREATE OR REPLACE FUNCTION domain.privacy_subject_restricted(scope_tenant uuid,subject text,category text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT category='RESERVATIONS' $$",
          );
          const result = await exportOwnPersonalData(
            domain,
            actor("citizen", false),
            randomUUID(),
          );
          assert.equal(
            result.records.some((r) => r.category === "RESERVATIONS"),
            false,
          );
          assert.equal(result.completeness.restrictedCategories.length, 2);
          assert.equal(
            result.records.some((r) => r.category === "IDENTITY"),
            true,
          );
        } finally {
          await migration.query(definition);
        }
      },
    );
    await t.test(
      "archived records require review without hiding accessible records of the same category",
      async () => {
        const definition = (
          await migration.query(
            "SELECT pg_get_functiondef('domain.personal_data_restricted_categories(text,uuid,boolean,boolean)'::regprocedure) AS sql",
          )
        ).rows[0].sql;
        try {
          await migration.query(
            `CREATE OR REPLACE FUNCTION domain.personal_data_restricted_categories(subject text,scope_tenant uuid,include_global boolean,include_municipal boolean) RETURNS TABLE(category text,tenant_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT 'RESERVATIONS'::text,'${first}'::uuid WHERE include_municipal AND (scope_tenant IS NULL OR scope_tenant='${first}'::uuid) $$`,
          );
          const result = await exportOwnPersonalData(
            domain,
            actor("citizen", false),
            randomUUID(),
          );
          assert.equal(
            result.records.filter((r) => r.type === "reservation").length,
            2,
          );
          assert.deepEqual(result.completeness.restrictedCategories, [
            { category: "RESERVATIONS", tenantId: first },
          ]);
          const global = await exportGlobalPersonalData(
            domain,
            actor("global-reader"),
            "citizen",
            authorization,
            randomUUID(),
          );
          assert.deepEqual(global.completeness.restrictedCategories, []);
        } finally {
          await migration.query(definition);
        }
      },
    );
    await t.test(
      "HTTP exposes scoped JSON contracts with no-store and rejects CSRF and extra fields",
      async () => {
        const app = Fastify({
          logger: false,
          genReqId: () => randomUUID(),
          ajv: {
            customOptions: { removeAdditional: false, coerceTypes: false },
          },
        });
        await app.register(swagger, {
          openapi: {
            info: { title: "Personal data tests", version: "1" },
            components: {
              securitySchemes: {
                quendaSession: {
                  type: "apiKey",
                  in: "cookie",
                  name: "__Secure-quenda.session_token",
                },
              },
            },
          },
        });
        registerErrors(app);
        const authentication = {
          authenticate: async (headers: Headers) => {
            const id = headers.get("x-test-actor");
            return id ? actor(id, !["citizen", "other"].includes(id)) : null;
          },
        } as Authentication;
        await registerPersonalDataRoutes(app, domain, authentication, {
          origin: "https://quenda.test",
          secret: "test-secret",
        });
        const contracts = verifyProductResponses(app);
        try {
          const own = await app.inject({
            url: "/api/me/personal-data",
            headers: { "x-test-actor": "citizen" },
          });
          assert.equal(own.statusCode, 200, own.body);
          assert.equal(own.headers["cache-control"], "no-store");
          assert.match(
            String(own.headers["content-disposition"]),
            /attachment/,
          );
          assert.equal(
            (await app.inject({ url: "/api/me/personal-data" })).statusCode,
            401,
          );
          const url = `/api/municipalities/${first}/accounts/citizen/personal-data`;
          assert.equal(
            (
              await app.inject({
                method: "POST",
                url,
                headers: { "x-test-actor": "reader" },
                payload: authorization,
              })
            ).statusCode,
            403,
          );
          const headers = {
            "x-test-actor": "reader",
            origin: "https://quenda.test",
          };
          assert.equal(
            (
              await app.inject({
                method: "POST",
                url,
                headers,
                payload: { reason: "Only reason" },
              })
            ).statusCode,
            400,
          );
          assert.equal(
            (
              await app.inject({
                method: "POST",
                url,
                headers,
                payload: { ...authorization, unexpected: "field" },
              })
            ).statusCode,
            400,
          );
          const municipal = await app.inject({
            method: "POST",
            url,
            headers,
            payload: authorization,
          });
          assert.equal(municipal.statusCode, 200, municipal.body);
          const global = await app.inject({
            method: "POST",
            url: "/api/platform/accounts/citizen/personal-data",
            headers: {
              "x-test-actor": "global-reader",
              origin: "https://quenda.test",
            },
            payload: authorization,
          });
          assert.equal(global.statusCode, 200, global.body);
          contracts.assertValid();
          assert.equal(contracts.successes.size, 3);
        } finally {
          await app.close();
        }
      },
    );
    await t.test(
      "oversized datasets fail explicitly rather than silently truncating",
      async () => {
        await migration.query(
          "INSERT INTO auth.session_event(subject_id,operation) SELECT 'citizen','SESSION_CREATED' FROM generate_series(1,10001)",
        );
        const before = (
          await migration.query(
            "SELECT count(*)::int AS n FROM domain.personal_data_access_event",
          )
        ).rows[0].n;
        await assert.rejects(
          exportOwnPersonalData(domain, actor("citizen", false), randomUUID()),
          { code: "PERSONAL_DATA_TOO_LARGE" },
        );
        assert.equal(
          (
            await migration.query(
              "SELECT count(*)::int AS n FROM domain.personal_data_access_event",
            )
          ).rows[0].n,
          before,
        );
        await migration.query(
          "DELETE FROM auth.session_event WHERE subject_id='citizen'",
        );
      },
    );
  });
});
