import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Ajv } from "ajv";
import addFormats from "ajv-formats";
import Fastify from "fastify";
import ICAL from "ical.js";
import { transaction } from "../../src/database/transaction.ts";
import { registerErrors } from "../../src/http/errors.ts";
import { catalogExportSchema } from "../../src/modules/catalog/export-schema.ts";
import { registerCatalog } from "../../src/modules/catalog/routes.ts";
import { registerCommunications } from "../../src/modules/communications/index.ts";
import type { Authentication } from "../../src/modules/identity/auth.ts";
import { registerReservationQueries } from "../../src/modules/reservations/query-routes.ts";
import { withDatabase } from "../helpers/postgres.ts";
import { seedUsageRules } from "../helpers/usage-rules-fixture.ts";

test("the catalog and reservations leave the system as open files, and calendar files belong to their holder", {
  timeout: 120000,
}, async () => {
  await withDatabase(async ({ auth, domain, migration }) => {
    const accounts = ["admin", "holder", "other", "=cmd|calc", "manager"];
    for (const id of accounts)
      await auth.query(
        'INSERT INTO auth."user"(id,name,email,"emailVerified","twoFactorEnabled") VALUES($1,$1,$2,true,true)',
        [id, `${id.replace(/[^a-z]/g, "x")}@example.test`],
      );
    const tenant = randomUUID(),
      otherTenant = randomUUID(),
      facility = randomUUID(),
      unit = randomUUID(),
      otherFacility = randomUUID();
    for (const [id, name] of [
      [tenant, "Oleiros"],
      [otherTenant, "Outro concello"],
    ] as const)
      await migration.query(
        "INSERT INTO domain.municipality(id,name,timezone,advance_days,cancellation_minutes) VALUES($1,$2,'Europe/Madrid',45,720)",
        [id, name],
      );
    await migration.query(
      "INSERT INTO domain.municipal_profile(tenant_id,account_id) VALUES($1,'admin'),($1,'holder'),($1,'other'),($1,'=cmd|calc'),($1,'manager')",
      [tenant],
    );
    const invitation = randomUUID();
    await migration.query(
      "INSERT INTO domain.administrator_invitation(tenant_id,id,account_id,invited_by,expires_at,accepted_at) VALUES($1,$2,'admin','admin',now()+interval '1 hour',now())",
      [tenant, invitation],
    );
    await migration.query(
      "INSERT INTO domain.municipal_administrator(tenant_id,account_id,invitation_id) VALUES($1,'admin',$2)",
      [tenant, invitation],
    );
    await migration.query(
      "INSERT INTO domain.facility(tenant_id,id,name,published_at,address,postal_code,latitude,longitude,description_es) VALUES($1,$2,'Polideportivo',now(),'Rúa do Mar 4, bajo; local','15001',43.362346,-8.4115,'Pabellón cubierto'),($3,$4,'Instalación ajena',now(),NULL,NULL,NULL,NULL,'Datos de otro municipio')",
      [tenant, facility, otherTenant, otherFacility],
    );
    await migration.query(
      "INSERT INTO domain.reservable_unit(tenant_id,id,facility_id,name,kind,indoor,capacity) VALUES($1,$2,$3,'Pista 1','padel',false,4)",
      [tenant, unit, facility],
    );
    await migration.query(
      `INSERT INTO domain.unit_calendar_version(tenant_id,unit_id,version,minimum_minutes,maximum_minutes,step_minutes,weekly,exceptions,actor_id,reason)
       VALUES($1,$2,1,60,60,60,$3,$4,'admin','Fixture')`,
      [
        tenant,
        unit,
        JSON.stringify(
          Array.from({ length: 7 }, (_, day) => ({
            day: day + 1,
            startMinute: 480,
            endMinute: 1200,
          })),
        ),
        JSON.stringify([{ date: "2030-12-25", intervals: [] }]),
      ],
    );
    await migration.query(
      "UPDATE domain.reservable_unit SET calendar_version=1 WHERE tenant_id=$1 AND id=$2",
      [tenant, unit],
    );
    await seedUsageRules(migration, tenant, unit, "admin");
    await migration.query(
      "UPDATE domain.reservable_unit SET published_at=now() WHERE tenant_id=$1 AND id=$2",
      [tenant, unit],
    );

    // Reservations: 105 upcoming confirmed, one cancelled, one past, plus one of another account and one with a formula-like holder id.
    const insert = async (
      holder: string,
      startsAt: string,
      status: "CONFIRMADA" | "CANCELADA",
      id = randomUUID(),
    ) => {
      // The occupancy invariant is checked when the transaction commits, so all rows go together.
      await transaction(migration, async (client) => {
        await client.query(
          `INSERT INTO domain.reservation(tenant_id,id,account_id,unit_id,calendar_version,starts_at,ends_at,status,cancellation_minutes,timezone)
           VALUES($1,$2,$3,$4,1,$5::timestamptz,$5::timestamptz+interval '1 hour',$6,720,'Europe/Madrid')`,
          [tenant, id, holder, unit, startsAt, status],
        );
        if (status === "CONFIRMADA")
          await client.query(
            "INSERT INTO domain.occupancy(tenant_id,id,unit_id,reservation_id,period) SELECT tenant_id,gen_random_uuid(),unit_id,id,tstzrange(starts_at,ends_at,'[)') FROM domain.reservation WHERE tenant_id=$1 AND id=$2",
            [tenant, id],
          );
        await client.query(
          "INSERT INTO domain.reservation_event(tenant_id,id,reservation_id,revision,kind,actor_id,correlation_id,after_state) SELECT tenant_id,gen_random_uuid(),id,1,$3,account_id,gen_random_uuid(),domain.reservation_snapshot(r) FROM domain.reservation r WHERE tenant_id=$1 AND id=$2",
          [tenant, id, status],
        );
      });
      return id;
    };
    const day = (n: number) =>
      new Date(Date.UTC(2031, 0, 1 + n, 10)).toISOString();
    const upcoming: string[] = [];
    for (let n = 0; n < 105; n++)
      upcoming.push(await insert("holder", day(n), "CONFIRMADA"));
    const cancelled = await insert("holder", day(200), "CANCELADA");
    const past = await insert("holder", "2024-01-01T10:00:00Z", "CONFIRMADA");
    const foreign = await insert("other", day(300), "CONFIRMADA");
    const formula = await insert("=cmd|calc", day(250), "CONFIRMADA");

    let current: string | null = "admin";
    let recent = true;
    const authentication = {
      authenticate: async () =>
        current
          ? {
              accountId: current,
              email: `${current}@example.test`,
              sessionId: current,
              mfaVerifiedAt: recent
                ? new Date()
                : new Date(Date.now() - 3600000),
            }
          : null,
    } as unknown as Authentication;
    const config = {
      origin: "https://quenda.test",
      secret: "portability-secret",
    };
    const app = Fastify({
      genReqId: () => randomUUID(),
      ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
    });
    registerErrors(app);
    await registerCatalog(app, domain, authentication, config);
    await registerCommunications(app, domain, authentication, config);
    await registerReservationQueries(app, domain, authentication, config);
    const as = async (
      account: string | null,
      run: () => Promise<void>,
      fresh = true,
    ) => {
      current = account;
      recent = fresh;
      await run();
    };
    try {
      await test("the catalog export is a complete, schema-valid document without reservations or personal data", async () => {
        await as("admin", async () => {
          const response = await app.inject(
            `/api/municipalities/${tenant}/exports/catalog`,
          );
          assert.equal(response.statusCode, 200, response.body);
          assert.equal(response.headers["cache-control"], "no-store");
          assert.equal(
            response.headers["content-disposition"],
            'attachment; filename="quenda-catalog-v1.json"',
          );
          const document = response.json();
          const validator = new Ajv({ strict: false, allErrors: true });
          addFormats.default(validator);
          assert.ok(
            validator.validate(catalogExportSchema, document),
            validator.errorsText(),
          );
          assert.equal(document.format, "quenda.catalog");
          assert.deepEqual(document.municipality.bookingPolicy, {
            version: 1,
            advanceDays: 45,
            cancellationMinutes: 720,
          });
          assert.equal(document.facilities.length, 1);
          assert.equal(
            document.facilities[0].profile.address,
            "Rúa do Mar 4, bajo; local",
          );
          assert.equal(document.units.length, 1);
          const exported = document.units[0];
          assert.equal(exported.profile.kind, "padel");
          assert.equal(exported.calendar.weekly.length, 7);
          assert.deepEqual(exported.calendar.exceptions, [
            { date: "2030-12-25", intervals: [] },
          ]);
          assert.equal(exported.usageRules.version, 1);
          const text = response.body;
          for (const leak of [
            "holder",
            "=cmd",
            "reservations",
            "Instalación ajena",
            "Datos de otro municipio",
            "@example.test",
          ])
            assert.ok(!text.includes(leak), `the export mentions ${leak}`);
        });
      });

      await test("only the municipality's administrator with recent verification may export it", async () => {
        const url = `/api/municipalities/${tenant}/exports/catalog`;
        await as("manager", async () =>
          assert.equal((await app.inject(url)).statusCode, 403),
        );
        await as("other", async () =>
          assert.equal((await app.inject(url)).statusCode, 403),
        );
        await as(
          "admin",
          async () =>
            assert.equal(
              (await app.inject(url)).statusCode,
              403 /* REAUTHENTICATION_REQUIRED */,
            ),
          false,
        );
        await as("admin", async () =>
          assert.equal(
            (
              await app.inject(
                `/api/municipalities/${otherTenant}/exports/catalog`,
              )
            ).statusCode,
            403,
          ),
        );
        await as(null, async () =>
          assert.equal((await app.inject(url)).statusCode, 401),
        );
      });

      await test("reservations export as CSV with the same rows as the JSON and neutralised formulas", async () => {
        await as("admin", async () => {
          const base = `/api/municipalities/${tenant}/exports/reservations?from=2031-01-01&to=2031-12-31`;
          const json = await app.inject(base);
          assert.equal(json.statusCode, 200, json.body);
          const csv = await app.inject(`${base}&format=csv`);
          assert.equal(csv.statusCode, 200, csv.body);
          assert.match(String(csv.headers["content-type"]), /^text\/csv/);
          assert.equal(
            csv.headers["content-disposition"],
            'attachment; filename="quenda-reservations-v3.csv"',
          );
          const lines = csv.body.slice(1).trimEnd().split("\r\n");
          assert.equal(lines.length, 1 + json.json().reservations.length);
          assert.ok(
            lines[0]?.startsWith(
              "id,unitId,accountId,startsAt,endsAt,timeZone,status,",
            ),
          );
          const formulaRow = lines.find((line) =>
            line.startsWith(`${formula},`),
          );
          assert.ok(formulaRow?.includes(",'=cmd|calc,"), formulaRow);
          assert.equal(
            (await app.inject(`${base}&format=xml`)).statusCode,
            400,
          );
        });
        await as(null, async () =>
          assert.equal(
            (
              await app.inject(
                `/api/municipalities/${tenant}/exports/reservations?from=2031-01-01&to=2031-12-31&format=csv`,
              )
            ).statusCode,
            401,
          ),
        );
      });

      await test("a holder downloads one reservation as a calendar entry with its place, link and revision", async () => {
        await as("holder", async () => {
          const response = await app.inject({
            url: `/api/municipalities/${tenant}/reservations/${upcoming[0]}/calendar.ics`,
            headers: { "accept-language": "gl" },
          });
          assert.equal(response.statusCode, 200, response.body);
          assert.match(
            String(response.headers["content-type"]),
            /^text\/calendar/,
          );
          assert.equal(response.headers["cache-control"], "no-store");
          assert.match(
            String(response.headers["content-disposition"]),
            /^attachment; filename="quenda-reserva-[0-9a-f]{8}\.ics"$/,
          );
          const root = new ICAL.Component(ICAL.parse(response.body));
          const [vevent] = root.getAllSubcomponents("vevent");
          assert.ok(vevent);
          const event = new ICAL.Event(vevent);
          assert.equal(event.uid, `${upcoming[0]}@quenda.test`);
          assert.equal(event.startDate.toJSDate().toISOString(), day(0));
          assert.equal(event.summary, "Reserva: Pista 1 (Oleiros)");
          assert.equal(
            event.location,
            "Polideportivo, Rúa do Mar 4, bajo; local, 15001",
          );
          assert.equal(vevent.getFirstPropertyValue("status"), "CONFIRMED");
          assert.equal(vevent.getFirstPropertyValue("sequence"), 1);
          assert.deepEqual(vevent.getFirstProperty("geo")?.getValues(), [
            [43.362346, -8.4115],
          ]);
          assert.ok(
            String(event.description).includes(
              `https://quenda.test/reservas/${tenant}/${upcoming[0]}`,
            ),
          );
          assert.ok(
            String(event.description).includes(
              "Consultar ou cambiar a reserva",
            ),
          );
          // The language chosen in the application wins over the browser's header.
          const chosen = await app.inject({
            url: `/api/municipalities/${tenant}/reservations/${upcoming[0]}/calendar.ics?lang=es`,
            headers: { "accept-language": "gl" },
          });
          assert.ok(chosen.body.includes("Consultar o cambiar la reserva"));
          assert.equal(
            (await app.inject("/api/me/reservations/calendar.ics?lang=fr"))
              .statusCode,
            400,
          );
        });
      });

      await test("a cancelled reservation is published as cancelled with the same identity", async () => {
        await as("holder", async () => {
          const response = await app.inject(
            `/api/municipalities/${tenant}/reservations/${cancelled}/calendar.ics`,
          );
          assert.equal(response.statusCode, 200, response.body);
          assert.ok(response.body.includes("STATUS:CANCELLED"));
          assert.ok(response.body.includes(`UID:${cancelled}@quenda.test`));
        });
      });

      await test("nobody else can download it, and malformed or unauthenticated requests are refused", async () => {
        const one = (id: string, t = tenant) =>
          `/api/municipalities/${t}/reservations/${id}/calendar.ics`;
        await as("other", async () => {
          assert.equal(
            (await app.inject(one(upcoming[0] as string))).statusCode,
            404,
          );
        });
        await as("admin", async () => {
          assert.equal(
            (await app.inject(one(upcoming[0] as string))).statusCode,
            404,
          );
        });
        await as("holder", async () => {
          assert.equal(
            (await app.inject(one(upcoming[0] as string, otherTenant)))
              .statusCode,
            404,
          );
          assert.equal((await app.inject(one(randomUUID()))).statusCode, 404);
          assert.equal((await app.inject(one("not-a-uuid"))).statusCode, 400);
        });
        await as(null, async () => {
          assert.equal(
            (await app.inject(one(upcoming[0] as string))).statusCode,
            401,
          );
          assert.equal(
            (await app.inject("/api/me/reservations/calendar.ics")).statusCode,
            401,
          );
        });
      });

      await test("the upcoming calendar holds only the account's confirmed, unfinished reservations, soonest first and capped", async () => {
        await as("holder", async () => {
          const response = await app.inject(
            "/api/me/reservations/calendar.ics",
          );
          assert.equal(response.statusCode, 200, response.body);
          const root = new ICAL.Component(ICAL.parse(response.body));
          const events = root
            .getAllSubcomponents("vevent")
            .map((e) => new ICAL.Event(e));
          assert.equal(events.length, 100);
          const starts = events.map((e) => e.startDate.toJSDate().getTime());
          assert.deepEqual(
            starts,
            [...starts].sort((a, b) => a - b),
          );
          const uids = new Set(events.map((e) => e.uid));
          for (const excluded of [cancelled, past, foreign, formula])
            assert.ok(!uids.has(`${excluded}@quenda.test`), excluded);
          assert.ok(uids.has(`${upcoming[0]}@quenda.test`));
          assert.ok(!uids.has(`${upcoming[104]}@quenda.test`));
          assert.equal(
            root.getFirstPropertyValue("x-wr-calname"),
            "Mis reservas de Quenda",
          );
        });
        await as("other", async () => {
          const events = new ICAL.Component(
            ICAL.parse(
              (await app.inject("/api/me/reservations/calendar.ics")).body,
            ),
          ).getAllSubcomponents("vevent");
          assert.equal(events.length, 1);
        });
      });
    } finally {
      await app.close();
    }
  });
});
