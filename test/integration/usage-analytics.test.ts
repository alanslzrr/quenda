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

test("usage analytics aggregates cancellations, lead time and arrivals within report authority", {
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
      const reader = await seedMunicipalBrowser(
        app,
        auth,
        domain,
        migration,
        2,
      );
      await auth.query(
        'INSERT INTO auth."user"(id,name,email,"emailVerified") VALUES($1,$1,$2,true)',
        ["analytics-holder", "analytics-holder@example.test"],
      );
      await migration.query(
        "INSERT INTO domain.municipal_profile(tenant_id,account_id) VALUES($1,'analytics-holder')",
        [f.tenant],
      );
      // Finished reservations last month: one attended, one not, one cancelled
      // by the holder and one by staff. Created two days before their start.
      const insert = async (
        unit: string,
        day: number,
        status: "CONFIRMADA" | "CANCELADA",
        actor: string,
        arrived = false,
      ) => {
        const id = randomUUID();
        await transaction(migration, async (client) => {
          await client.query(
            `INSERT INTO domain.reservation(tenant_id,id,account_id,unit_id,calendar_version,starts_at,ends_at,status,cancellation_minutes,timezone,created_at)
             VALUES($1,$2,'analytics-holder',$3,1,date_trunc('month',now())-interval '1 month'+make_interval(days=>$4,hours=>9),
              date_trunc('month',now())-interval '1 month'+make_interval(days=>$4,hours=>10),$5,0,'Europe/Madrid',
              date_trunc('month',now())-interval '1 month'+make_interval(days=>$4-2,hours=>9))`,
            [f.tenant, id, unit, day, status],
          );
          if (status === "CONFIRMADA")
            await client.query(
              "INSERT INTO domain.occupancy(tenant_id,id,unit_id,reservation_id,period) SELECT tenant_id,gen_random_uuid(),unit_id,id,tstzrange(starts_at,ends_at,'[)') FROM domain.reservation WHERE tenant_id=$1 AND id=$2",
              [f.tenant, id],
            );
          await client.query(
            "INSERT INTO domain.reservation_event(tenant_id,id,reservation_id,revision,kind,actor_id,correlation_id,after_state) SELECT tenant_id,gen_random_uuid(),id,1,$3,$4,gen_random_uuid(),domain.reservation_snapshot(r) FROM domain.reservation r WHERE tenant_id=$1 AND id=$2",
            [f.tenant, id, status, actor],
          );
          if (arrived)
            await client.query(
              "UPDATE domain.reservation SET arrived_at=ends_at-interval '50 minutes',arrival_recorded_by=$3 WHERE tenant_id=$1 AND id=$2",
              [f.tenant, id, f.accountId],
            );
        });
      };
      await insert(f.unit, 2, "CONFIRMADA", "analytics-holder", true);
      await insert(f.unit, 3, "CONFIRMADA", "analytics-holder");
      await insert(f.unit, 4, "CANCELADA", "analytics-holder");
      await insert(f.otherUnit, 5, "CANCELADA", f.accountId);
      const period = await migration.query<{ from: string; to: string }>(
        "SELECT to_char(date_trunc('month',now())-interval '1 month','YYYY-MM-DD') AS from,to_char(date_trunc('month',now()),'YYYY-MM-DD') AS to",
      );
      const { from, to } = period.rows[0] as { from: string; to: string };

      const signIn = async (
        account: { email: string; password: string; secret: string },
        ip: string,
        mfa = true,
      ) => {
        const client = browser(app, ip, config.origin);
        await client.request("/api/auth/sign-in/email", {
          email: account.email,
          password: account.password,
        });
        if (mfa)
          await client.request("/api/auth/two-factor/verify-totp", {
            code: totp(account.secret),
          });
        return client;
      };
      const admin = await signIn(f, "192.0.2.160");
      const path = `/api/municipalities/${f.tenant}/analytics?from=${from}&to=${to}`;

      await test("the municipality sees aggregates and never the holders", async () => {
        const response = await admin.request(path);
        assert.equal(response.statusCode, 200, response.body);
        assert.equal(response.headers["cache-control"], "no-store");
        const body = response.json();
        assert.deepEqual(body.cancellations, {
          reservations: 4,
          cancelled: 2,
          byHolder: 1,
          administrative: 1,
          cancelledPercent: 50,
        });
        assert.equal(body.leadTime.oneToThreeDays, 4);
        assert.deepEqual(body.attendance, {
          finished: 2,
          arrived: 1,
          arrivedPercent: 50,
        });
        assert.equal(body.units.length, 2);
        assert.deepEqual(
          body.units.map((u: { name: string }) => u.name).sort(),
          ["Pista 1", "Pista 2"],
        );
        assert.equal(
          body.units.reduce(
            (sum: number, u: { reservedMinutes: number }) =>
              sum + u.reservedMinutes,
            0,
          ),
          120,
        );
        assert.ok(!response.body.includes("analytics-holder"));
        assert.ok(!response.body.includes(f.accountId));
        const basic = await admin.request(
          `/api/municipalities/${f.tenant}/indicators?from=${from}&to=${to}`,
        );
        assert.equal(basic.json().reservedMinutes, 120);
      });

      await test("one unit can be analysed on its own", async () => {
        const unit = await admin.request(`${path}&unitId=${f.otherUnit}`);
        assert.equal(unit.statusCode, 200, unit.body);
        assert.equal(unit.json().unitId, f.otherUnit);
        assert.equal(unit.json().units.length, 1);
        assert.equal(unit.json().cancellations.administrative, 1);
        assert.equal(unit.json().cancellations.reservations, 1);
      });

      await test("report authority over one unit does not open the municipal analysis", async () => {
        const actor = (account: { accountId: string; email: string }) => ({
          accountId: account.accountId,
          email: account.email,
          sessionId: "synthetic",
          mfaVerifiedAt: new Date(),
        });
        const invitation = await inviteManager(domain, actor(f), f.tenant, {
          accountId: reader.accountId,
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
          permissions: [{ operation: "REPORT_READ", unitId: f.unit }],
        });
        await acceptManager(
          domain,
          actor(reader),
          f.tenant,
          invitation.invitationId,
        );
        const limited = await signIn(reader, "192.0.2.161");
        assert.equal((await limited.request(path)).statusCode, 403);
        assert.equal(
          (await limited.request(`${path}&unitId=${f.otherUnit}`)).statusCode,
          403,
        );
        assert.equal(
          (await limited.request(`${path}&unitId=${f.unit}`)).statusCode,
          200,
        );
      });

      await test("a session without MFA and invalid periods are refused", async () => {
        const plain = await signIn(f, "192.0.2.162", false);
        assert.ok([401, 403].includes((await plain.request(path)).statusCode));
        assert.equal(
          (
            await admin.request(
              `/api/municipalities/${f.tenant}/analytics?from=${to}&to=${from}`,
            )
          ).statusCode,
          400,
        );
        assert.equal(
          (
            await admin.request(
              `/api/municipalities/${f.tenant}/analytics?from=2030-01-01&to=2031-06-01`,
            )
          ).statusCode,
          400,
        );
      });
      contract.assertValid();
    } finally {
      await app.close();
    }
  });
});
