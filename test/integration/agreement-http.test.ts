import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { buildApp } from "../../src/app.ts";
import { createAuthentication } from "../../src/modules/identity/index.ts";
import type { MailMessage } from "../../src/shared/mail.ts";
import { browser, totp } from "../helpers/auth-client.ts";
import { withDatabase } from "../helpers/postgres.ts";

test("agreement HTTP requires real sessions, MFA and version-specific approvals across replicas", {
  timeout: 60000,
}, async () => {
  await withDatabase(async ({ domain, auth, migration }) => {
    const messages: MailMessage[] = [];
    const config = {
      origin: "https://quenda.test",
      secret: randomBytes(32).toString("hex"),
    };
    const make = () =>
      buildApp({
        database: { check: async () => {}, close: async () => {} },
        domain,
        logLevel: "silent",
        idempotencyRetentionSeconds: 3600,
        identity: {
          config,
          authentication: createAuthentication(auth, config, {
            send: async (message) => {
              messages.push(message);
            },
          }),
        },
      });
    const app = await make(),
      replica = await make();
    try {
      const client = browser(app, "192.0.2.162");
      const password = "Synthetic-password-1234!";
      const signup = await client.request("/api/auth/sign-up/email", {
        name: "Administrator",
        email: "agreement@example.test",
        password,
      });
      assert.equal(signup.statusCode, 200, signup.body);
      const accountId = signup.json().user.id;
      const tenant = randomUUID(),
        facility = randomUUID(),
        unit = randomUUID(),
        invitation = randomUUID();
      await migration.query(
        "INSERT INTO domain.municipality(id,name,timezone) VALUES($1,'Synthetic','Europe/Madrid')",
        [tenant],
      );
      await migration.query(
        "INSERT INTO domain.facility(tenant_id,id,name) VALUES($1,$2,'Facility')",
        [tenant, facility],
      );
      await migration.query(
        "INSERT INTO domain.reservable_unit(tenant_id,id,facility_id,name) VALUES($1,$2,$3,'Unit')",
        [tenant, unit, facility],
      );
      await migration.query(
        "INSERT INTO domain.municipal_profile(tenant_id,account_id) VALUES($1,$2)",
        [tenant, accountId],
      );
      await migration.query(
        "INSERT INTO domain.administrator_invitation(tenant_id,id,account_id,invited_by,expires_at,accepted_at) VALUES($1,$2,$3,$3,now()+interval '1 day',now())",
        [tenant, invitation, accountId],
      );
      await migration.query(
        "INSERT INTO domain.municipal_administrator(tenant_id,account_id,invitation_id) VALUES($1,$2,$3)",
        [tenant, accountId, invitation],
      );
      const url = `/api/municipalities/${tenant}/agreements`;
      const input = {
        name: "Joint programme",
        timeZone: "Europe/Madrid",
        startsAt: "2030-01-01T00:00:00Z",
        endsAt: "2031-01-01T00:00:00Z",
        purpose: "Shared access",
        legalBasis: "Synthetic reference",
        responsibilities: "Municipal management",
        retentionPolicy: "Synthetic policy",
        eligibility: "acceso_abierto",
        weeklyLimit: 3,
        aggregateReports: false,
        participants: [
          { tenantId: tenant, accreditationIssuer: false, unitIds: [unit] },
        ],
      };
      const headers = { "idempotency-key": "http-draft" };
      assert.equal((await client.request(url, input, headers)).statusCode, 401);
      const message = messages.find((m) => m.text.includes("verify-email"));
      assert.ok(message);
      const verify = new URL(message.text.trim().split("\n").at(-1) ?? "");
      assert.ok(
        [200, 302].includes(
          (await client.request(verify.pathname + verify.search)).statusCode,
        ),
      );
      assert.equal(
        (
          await client.request("/api/auth/sign-in/email", {
            email: "agreement@example.test",
            password,
          })
        ).statusCode,
        200,
      );
      assert.equal((await client.request(url, input, headers)).statusCode, 403);
      const enrolled = await client.request("/api/auth/two-factor/enable", {
        password,
      });
      assert.equal(enrolled.statusCode, 200, enrolled.body);
      const secret = new URL(enrolled.json().totpURI).searchParams.get(
        "secret",
      );
      assert.ok(secret);
      const verified = await client.request(
        "/api/auth/two-factor/verify-totp",
        { code: totp(secret) },
      );
      assert.equal(verified.statusCode, 200, verified.body);
      assert.equal((await client.request(url, input)).statusCode, 400);
      assert.equal(
        (await client.request(url, { ...input, status: "ACTIVADO" }, headers))
          .statusCode,
        400,
      );
      assert.equal(
        (
          await client.request(url, input, {
            ...headers,
            origin: "https://external.test",
          })
        ).statusCode,
        403,
      );
      const saved = await client.request(url, input, headers);
      assert.equal(saved.statusCode, 201, saved.body);
      assert.equal(saved.json().status, "BORRADOR");
      assert.equal(saved.headers["cache-control"], "no-store");
      assert.equal(saved.headers["idempotency-retention-seconds"], "3600");
      const replay = await replica.inject({
        method: "POST",
        url,
        payload: input,
        headers: { ...headers, origin: config.origin, cookie: client.cookie() },
      });
      assert.equal(replay.statusCode, 201, replay.body);
      assert.equal(replay.headers["idempotency-replayed"], "true");
      assert.deepEqual(replay.json(), saved.json());
      const id = saved.json().agreementId;
      const approveUrl = `${url}/${id}/approve`,
        versionUrl = `${url}/${id}/versions`;
      assert.equal(
        (
          await client.request(
            approveUrl,
            { version: 1, unitIds: [] },
            { "idempotency-key": "wrong-units" },
          )
        ).statusCode,
        409,
      );
      const approved = await client.request(
        approveUrl,
        { version: 1, unitIds: [unit] },
        { "idempotency-key": "approve-one" },
      );
      assert.equal(approved.statusCode, 200, approved.body);
      assert.equal(approved.json().status, "APROBADO");
      const { name: _name, timeZone: _zone, ...configuration } = input;
      const revised = { ...configuration, expectedVersion: 1, weeklyLimit: 2 };
      assert.equal(
        (
          await client.request(
            versionUrl,
            { ...revised, timeZone: "UTC" },
            { "idempotency-key": "change-zone" },
          )
        ).statusCode,
        400,
      );
      const version = await client.request(versionUrl, revised, {
        "idempotency-key": "version-two",
      });
      assert.equal(version.statusCode, 201, version.body);
      assert.deepEqual(version.json(), {
        agreementId: id,
        version: 2,
        status: "BORRADOR",
      });
      assert.equal(
        (
          await client.request(versionUrl, revised, {
            "idempotency-key": "stale-version",
          })
        ).statusCode,
        409,
      );
      assert.equal(
        (
          await client.request(
            approveUrl,
            { version: 1, unitIds: [unit] },
            { "idempotency-key": "stale-approval" },
          )
        ).statusCode,
        409,
      );
      const approvedTwo = await client.request(
        approveUrl,
        { version: 2, unitIds: [unit] },
        { "idempotency-key": "approve-two" },
      );
      assert.equal(approvedTwo.statusCode, 200, approvedTwo.body);
      assert.equal(approvedTwo.json().status, "APROBADO");
      const oldReplay = await replica.inject({
        method: "POST",
        url: versionUrl,
        payload: revised,
        headers: {
          origin: config.origin,
          cookie: client.cookie(),
          "idempotency-key": "version-two",
        },
      });
      assert.equal(oldReplay.statusCode, 201, oldReplay.body);
      assert.equal(oldReplay.json().status, "BORRADOR");
      assert.equal(
        (
          await migration.query(
            "SELECT count(*)::int AS n FROM domain.agreement_version WHERE status='ACTIVADO'",
          )
        ).rows[0].n,
        0,
      );
      const detailUrl = `${url}/${id}/versions/2`;
      const detail = await client.request(detailUrl);
      assert.equal(detail.statusCode, 200, detail.body);
      assert.equal(detail.headers["cache-control"], "no-store");
      assert.equal(detail.json().status, "APROBADO");
      assert.equal(detail.json().weeklyLimit, 2);
      assert.equal(detail.json().approvals.length, 1);
      assert.deepEqual(detail.json().participants, input.participants);
      const listing = await client.request(url);
      assert.equal(listing.statusCode, 200, listing.body);
      assert.deepEqual(
        listing.json().items.map((r: { version: number }) => r.version),
        [1, 2],
      );
      assert.equal(listing.json().nextCursor, null);
      assert.equal(
        (await client.request(`${url}?after=invalid`)).statusCode,
        400,
      );
      assert.equal(
        (await client.request(`${url}/${id}/versions/999`)).statusCode,
        404,
      );
      assert.equal(
        (await client.request(`${url}/${id}/versions/2147483648`)).statusCode,
        400,
      );
      await migration.query(
        "UPDATE domain.municipal_administrator SET revoked_at=now() WHERE tenant_id=$1 AND account_id=$2",
        [tenant, accountId],
      );
      assert.equal((await client.request(url, input, headers)).statusCode, 403);
      assert.equal(
        (
          await client.request(
            approveUrl,
            { version: 2, unitIds: [unit] },
            { "idempotency-key": "approve-two" },
          )
        ).statusCode,
        403,
      );
      assert.equal((await client.request(detailUrl)).statusCode, 403);
      assert.equal((await client.request(url)).statusCode, 403);
      assert.equal(
        (await client.request("/api/auth/sign-out", {})).statusCode,
        200,
      );
      assert.equal((await client.request(url, input, headers)).statusCode, 401);
      assert.equal((await client.request(detailUrl)).statusCode, 401);
      const spec = app.swagger() as { paths: Record<string, unknown> };
      for (const path of [
        "/api/municipalities/{tenantId}/agreements",
        "/api/municipalities/{tenantId}/agreements/{agreementId}/versions",
        "/api/municipalities/{tenantId}/agreements/{agreementId}/approve",
      ])
        assert.ok(spec.paths[path]);
    } finally {
      await app.close();
      await replica.close();
    }
  });
});
