import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { buildApp } from "../../src/app.ts";
import { transaction } from "../../src/database/transaction.ts";
import { createAuthentication } from "../../src/modules/identity/index.ts";
import {
  acceptManager,
  inviteManager,
} from "../../src/modules/identity/manager.ts";
import { browser, totp } from "../helpers/auth-client.ts";
import { withDatabase } from "../helpers/postgres.ts";
import { verifyProductResponses } from "../helpers/response-contract.ts";
import { seedMunicipalBrowser } from "../helpers/web-municipal.ts";

test("staff record a holder's arrival only within the access window and with authority over the unit", {
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
      await auth.query(
        'INSERT INTO auth."user"(id,name,email,"emailVerified") VALUES($1,$1,$2,true)',
        ["arrival-holder", "arrival-holder@example.test"],
      );
      await migration.query(
        "INSERT INTO domain.municipal_profile(tenant_id,account_id) VALUES($1,'arrival-holder')",
        [f.tenant],
      );
      const insert = async (
        unit: string,
        startOffsetMinutes: number,
        status: "CONFIRMADA" | "CANCELADA" = "CONFIRMADA",
      ) => {
        const id = randomUUID();
        await transaction(migration, async (client) => {
          await client.query(
            `INSERT INTO domain.reservation(tenant_id,id,account_id,unit_id,calendar_version,starts_at,ends_at,status,cancellation_minutes,timezone)
             VALUES($1,$2,'arrival-holder',$3,1,date_trunc('minute',now())+make_interval(mins=>$4),date_trunc('minute',now())+make_interval(mins=>$4+60),$5,0,'Europe/Madrid')`,
            [f.tenant, id, unit, startOffsetMinutes, status],
          );
          if (status === "CONFIRMADA")
            await client.query(
              "INSERT INTO domain.occupancy(tenant_id,id,unit_id,reservation_id,period) SELECT tenant_id,gen_random_uuid(),unit_id,id,tstzrange(starts_at,ends_at,'[)') FROM domain.reservation WHERE tenant_id=$1 AND id=$2",
              [f.tenant, id],
            );
          await client.query(
            "INSERT INTO domain.reservation_event(tenant_id,id,reservation_id,revision,kind,actor_id,correlation_id,after_state) SELECT tenant_id,gen_random_uuid(),id,1,$3,account_id,gen_random_uuid(),domain.reservation_snapshot(r) FROM domain.reservation r WHERE tenant_id=$1 AND id=$2",
            [f.tenant, id, status],
          );
        });
        return id;
      };
      // Ten minutes ahead: inside the window that opens 30 minutes before the start.
      const soon = await insert(f.unit, 10);
      const soonOther = await insert(f.otherUnit, 10);
      const tomorrow = await insert(f.unit, 24 * 60);
      const cancelled = await insert(f.unit, 3 * 60, "CANCELADA");

      const signIn = async (
        account: { email: string; password: string; secret: string },
        ip: string,
      ) => {
        const client = browser(app, ip, config.origin);
        await client.request("/api/auth/sign-in/email", {
          email: account.email,
          password: account.password,
        });
        await client.request("/api/auth/two-factor/verify-totp", {
          code: totp(account.secret),
        });
        return client;
      };
      const admin = await signIn(f, "192.0.2.150");
      const base = `/api/municipalities/${f.tenant}/reservations`;
      const arrive = (client: typeof admin, id: string) =>
        client.request(`${base}/${id}/arrival`, {});

      await test("staff without authority over the municipality see nothing", async () => {
        const outsider = await signIn(other, "192.0.2.151");
        assert.equal((await arrive(outsider, soon)).statusCode, 404);
      });

      await test("an administrator records the arrival once; repeating it keeps the first record", async () => {
        const first = await arrive(admin, soon);
        assert.equal(first.statusCode, 200, first.body);
        assert.equal(first.json().alreadyRecorded, false);
        const again = await arrive(admin, soon);
        assert.equal(again.statusCode, 200);
        assert.deepEqual(again.json(), {
          arrivedAt: first.json().arrivedAt,
          alreadyRecorded: true,
        });
        const detail = await admin.request(`${base}/${soon}`);
        assert.equal(detail.statusCode, 200, detail.body);
        assert.equal(detail.json().arrivedAt, first.json().arrivedAt);
        assert.equal(detail.json().revision, 1);
        const recorded = await migration.query(
          "SELECT arrival_recorded_by,(SELECT count(*) FROM domain.reservation_event e WHERE e.tenant_id=r.tenant_id AND e.reservation_id=r.id)::int AS events FROM domain.reservation r WHERE tenant_id=$1 AND id=$2",
          [f.tenant, soon],
        );
        assert.equal(recorded.rows[0].arrival_recorded_by, f.accountId);
        assert.equal(
          recorded.rows[0].events,
          1,
          "no reservation event or notice",
        );
      });

      await test("outside the access window or for a cancellation the request conflicts", async () => {
        for (const reservation of [tomorrow, cancelled]) {
          const rejected = await arrive(admin, reservation);
          assert.equal(rejected.statusCode, 409);
          assert.equal(rejected.json().error.code, "ARRIVAL_OUTSIDE_WINDOW");
        }
        assert.equal(
          (await admin.request(`${base}/${tomorrow}`)).json().arrivedAt,
          null,
        );
      });

      await test("read permission on one unit allows recording there and nowhere else", async () => {
        const actor = (account: { accountId: string; email: string }) => ({
          accountId: account.accountId,
          email: account.email,
          sessionId: "synthetic",
          mfaVerifiedAt: new Date(),
        });
        const invitation = await inviteManager(domain, actor(f), f.tenant, {
          accountId: other.accountId,
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
          permissions: [{ operation: "RESERVATION_READ", unitId: f.unit }],
        });
        await acceptManager(
          domain,
          actor(other),
          f.tenant,
          invitation.invitationId,
        );
        const reader = await signIn(other, "192.0.2.152");
        assert.equal((await arrive(reader, soonOther)).statusCode, 404);
        const repeated = await arrive(reader, soon);
        assert.equal(repeated.statusCode, 200);
        assert.equal(repeated.json().alreadyRecorded, true);
      });

      await test("a session without MFA and a foreign origin are refused", async () => {
        const plain = browser(app, "192.0.2.153", config.origin);
        await plain.request("/api/auth/sign-in/email", {
          email: f.email,
          password: f.password,
        });
        const unverified = await arrive(plain, soonOther);
        assert.ok([401, 403].includes(unverified.statusCode), unverified.body);
        const forged = browser(app, "192.0.2.154", "https://elsewhere.test");
        assert.equal(
          (await forged.request(`${base}/${soonOther}/arrival`, {})).statusCode,
          403,
        );
      });

      await test("the application role cannot write the arrival columns directly", async () => {
        await assert.rejects(
          transaction(
            domain,
            (client) =>
              client.query(
                "UPDATE domain.reservation SET arrived_at=now(),arrival_recorded_by=$3 WHERE tenant_id=$1 AND id=$2",
                [f.tenant, soonOther, f.accountId],
              ),
            { accountId: f.accountId, tenantId: f.tenant },
          ),
          /permission denied/,
        );
      });

      await test("the holder's personal data includes the arrival time", async () => {
        const records = await migration.query(
          "SELECT record FROM domain.personal_data_records('arrival-holder',NULL,false,true) WHERE record_type='reservation' AND record->>'reservationId'=$1",
          [soon],
        );
        assert.equal(records.rowCount, 1);
        assert.ok(records.rows[0].record.arrivedAt);
      });
      contract.assertValid();
    } finally {
      await app.close();
    }
  });
});
