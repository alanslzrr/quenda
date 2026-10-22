import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import swagger from "@fastify/swagger";
import Fastify from "fastify";
import { transaction } from "../../src/database/transaction.ts";
import { registerErrors } from "../../src/http/errors.ts";
import type { Authentication } from "../../src/modules/identity/auth.ts";
import { listOwnReservations } from "../../src/modules/reservations/queries.ts";
import { registerReservationQueries } from "../../src/modules/reservations/query-routes.ts";
import { withDatabase } from "../helpers/postgres.ts";
import { verifyProductResponses } from "../helpers/response-contract.ts";

test("own history filters before pagination and never broadens account access", {
  timeout: 60000,
}, async (t) => {
  await withDatabase(async ({ auth, domain, migration, worker }) => {
    const tenants = [randomUUID(), randomUUID()] as const;
    const expected = new Map<string, string[]>();
    for (const id of ["holder", "other"])
      await auth.query(
        'INSERT INTO auth."user"(id,name,email,"emailVerified","updatedAt") VALUES($1,$1,$2,true,now())',
        [id, `${id}@example.test`],
      );
    for (const tenant of tenants) {
      const facility = randomUUID(),
        unit = randomUUID();
      await migration.query(
        "INSERT INTO domain.municipality(id,name,timezone) VALUES($1,'History fixture','Europe/Madrid')",
        [tenant],
      );
      await migration.query(
        "INSERT INTO domain.municipal_profile(tenant_id,account_id) VALUES($1,'holder'),($1,'other')",
        [tenant],
      );
      await migration.query(
        "INSERT INTO domain.facility(tenant_id,id,name) VALUES($1,$2,'Historical facility')",
        [tenant, facility],
      );
      await migration.query(
        "INSERT INTO domain.reservable_unit(tenant_id,id,facility_id,name,withdrawn_at) VALUES($1,$2,$3,'Withdrawn unit',now())",
        [tenant, unit, facility],
      );
      await migration.query(
        "INSERT INTO domain.unit_calendar_version(tenant_id,unit_id,version,minimum_minutes,maximum_minutes,step_minutes,weekly,exceptions,actor_id,reason) VALUES($1,$2,1,60,60,60,'[]','[]','holder','Historical fixture')",
        [tenant, unit],
      );
      // The same IDs in both municipalities exercise the composite cursor.
      const rows = await transaction(migration, async (client) => {
        const inserted = await client.query<{ id: string; account_id: string }>(
          `INSERT INTO domain.reservation(tenant_id,id,account_id,unit_id,calendar_version,starts_at,ends_at,cancellation_minutes,timezone)
         SELECT $1,('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
           CASE WHEN n<=25 THEN 'holder' ELSE 'other' END,$2,1,
           '2024-01-01'::timestamptz+n*interval '1 hour','2024-01-01'::timestamptz+(n+1)*interval '1 hour',1440,'Europe/Madrid'
         FROM generate_series(1,27) n RETURNING id,account_id`,
          [tenant, unit],
        );
        await client.query(
          "INSERT INTO domain.occupancy(tenant_id,id,unit_id,reservation_id,period) SELECT tenant_id,gen_random_uuid(),unit_id,id,tstzrange(starts_at,ends_at,'[)') FROM domain.reservation WHERE tenant_id=$1",
          [tenant],
        );
        await client.query(
          "INSERT INTO domain.reservation_event(tenant_id,id,reservation_id,revision,kind,actor_id,correlation_id,after_state) SELECT tenant_id,gen_random_uuid(),id,1,'CONFIRMADA',account_id,gen_random_uuid(),domain.reservation_snapshot(r) FROM domain.reservation r WHERE tenant_id=$1",
          [tenant],
        );
        return inserted;
      });
      expected.set(
        tenant,
        rows.rows
          .filter((r) => r.account_id === "holder")
          .map((r) => r.id)
          .sort(),
      );
    }
    const actor = (accountId: string) => ({
      accountId,
      email: `${accountId}@example.test`,
      sessionId: `session-${accountId}`,
      mfaVerifiedAt: null,
    });
    const app = Fastify({
      logger: false,
      genReqId: () => randomUUID(),
      ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
    });
    await app.register(swagger, {
      openapi: {
        info: { title: "History test", version: "1" },
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
    await registerReservationQueries(
      app,
      domain,
      {
        authenticate: async (headers: Headers) => {
          const id = headers.get("x-test-account");
          return id && ["holder", "other"].includes(id) ? actor(id) : null;
        },
      } as Authentication,
      { origin: "https://quenda.test", secret: "test-only" },
    );
    const contracts = verifyProductResponses(app);
    try {
      await t.test(
        "HTTP keeps the municipality filter across full pages without losing or duplicating rows",
        async () => {
          for (const tenant of tenants) {
            const seen: string[] = [];
            let cursor: string | null = null;
            let pages = 0;
            do {
              const query = new URLSearchParams({ tenantId: tenant });
              if (cursor) query.set("after", cursor);
              const response = await app.inject({
                url: `/api/me/reservations?${query}`,
                headers: { "x-test-account": "holder" },
              });
              assert.equal(response.statusCode, 200, response.body);
              assert.equal(response.headers["cache-control"], "no-store");
              const page = response.json();
              assert.equal(page.items.length, pages === 0 ? 20 : 5);
              for (const item of page.items) {
                assert.equal(item.tenantId, tenant);
                assert.equal(item.status, "FINALIZADA");
                assert.equal("accountId" in item, false);
                seen.push(item.id);
              }
              cursor = page.nextCursor;
              assert.ok(++pages <= 2);
            } while (cursor);
            assert.deepEqual(seen, expected.get(tenant));
            assert.equal(new Set(seen).size, 25);
          }
        },
      );
      await t.test(
        "unfiltered history preserves the composite cursor and the other holder remains isolated",
        async () => {
          const seen: string[] = [];
          let after: string | null = null;
          do {
            const page = await listOwnReservations(domain, actor("holder"), {
              after,
            });
            seen.push(...page.items.map((r) => `${r.id}:${r.tenantId}`));
            after = page.nextCursor;
          } while (after);
          assert.equal(seen.length, 50);
          assert.equal(new Set(seen).size, 50);
          assert.deepEqual(seen, [...seen].sort());
          for (const tenant of tenants) {
            const result = await app.inject({
              url: `/api/me/reservations?tenantId=${tenant}`,
              headers: { "x-test-account": "other" },
            });
            assert.equal(result.statusCode, 200, result.body);
            assert.equal(result.json().items.length, 2);
            assert.equal(result.json().nextCursor, null);
            assert.ok(
              result
                .json()
                .items.every(
                  (r: { id: string; tenantId: string }) =>
                    r.tenantId === tenant &&
                    !expected.get(tenant)?.includes(r.id),
                ),
            );
          }
        },
      );
      await t.test(
        "empty scopes, validation and direct SQL cannot bypass account isolation",
        async () => {
          const empty = await app.inject({
            url: `/api/me/reservations?tenantId=${randomUUID()}`,
            headers: { "x-test-account": "holder" },
          });
          assert.equal(empty.statusCode, 200, empty.body);
          assert.deepEqual(empty.json(), { items: [], nextCursor: null });
          for (const query of [
            "tenantId=invalid",
            "tenantId=",
            `tenantId=${tenants[0]}&accountId=other`,
            `tenantId=${tenants[0]}&after=invalid`,
          ])
            assert.equal(
              (
                await app.inject({
                  url: `/api/me/reservations?${query}`,
                  headers: { "x-test-account": "holder" },
                })
              ).statusCode,
              400,
            );
          assert.equal(
            (
              await app.inject({
                url: `/api/me/reservations?tenantId=${tenants[0]}`,
              })
            ).statusCode,
            401,
          );
          await assert.rejects(
            listOwnReservations(domain, actor("holder"), {
              tenantId: "invalid",
            }),
            { code: "INVALID_INPUT" },
          );
          assert.equal(
            (
              await domain.query(
                "SELECT * FROM domain.own_reservations(NULL,NULL,$1)",
                [tenants[0]],
              )
            ).rowCount,
            0,
          );
          const own = await transaction(
            domain,
            (client) =>
              client.query(
                "SELECT * FROM domain.own_reservations(NULL,NULL,$1)",
                [tenants[0]],
              ),
            { accountId: "other", tenantId: tenants[1] },
          );
          assert.equal(own.rowCount, 2);
          assert.ok(
            own.rows.every(
              (r) =>
                r.tenant_id === tenants[0] &&
                !expected.get(tenants[0] ?? "")?.includes(r.id),
            ),
          );
          for (const pool of [auth, worker])
            await assert.rejects(
              pool.query(
                "SELECT * FROM domain.own_reservations(NULL,NULL,$1)",
                [tenants[0]],
              ),
              { code: "42501" },
            );
        },
      );
      contracts.assertValid();
    } finally {
      await app.close();
    }
  });
});
