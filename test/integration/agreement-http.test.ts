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
        startsAt: "2020-01-01T00:00:00Z",
        endsAt: "2040-01-01T00:00:00Z",
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
      const revised = {
        ...configuration,
        expectedVersion: 1,
        weeklyLimit: 2,
        eligibility: "acreditacion_vigente",
        participants: [
          { tenantId: tenant, accreditationIssuer: true, unitIds: [unit] },
        ],
      };
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
      assert.deepEqual(detail.json().participants, revised.participants);
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
      const credentialUrl = `/api/municipalities/${tenant}/credentials`;
      const credentialBody = {
        agreementId: id,
        version: 2,
        accountId,
        startsAt: "2026-01-01T00:00:00Z",
        endsAt: "2035-01-01T00:00:00Z",
        verificationReference: "Synthetic verified reference",
      };
      const credentialHeaders = { "idempotency-key": "http-credential" };
      assert.equal(
        (await client.request(credentialUrl, credentialBody, credentialHeaders))
          .statusCode,
        409,
      );
      const activateUrl = `${url}/${id}/activate`;
      const activateBody = {
        version: 2,
        legalReviewReference: "Synthetic legal review",
        reportReviewReference: null,
      };
      const activateHeaders = { "idempotency-key": "http-activate" };
      assert.equal(
        (
          await client.request(
            activateUrl,
            { ...activateBody, legalReviewReference: " " },
            activateHeaders,
          )
        ).statusCode,
        400,
      );
      const activated = await client.request(
        activateUrl,
        activateBody,
        activateHeaders,
      );
      assert.equal(activated.statusCode, 200, activated.body);
      assert.equal(activated.json().status, "ACTIVADO");
      const restrictionUrl = `/api/municipalities/${tenant}/units/${unit}/agreement-restriction`;
      const releaseUrl = `${restrictionUrl}/release`;
      const releaseBody = {
        expectedAgreementId: id,
        expectedVersion: 2,
        reason: "Municipal access restored",
      };
      const releaseHeaders = { "idempotency-key": "http-release" };
      const restricted = await client.request(restrictionUrl);
      assert.equal(restricted.statusCode, 200, restricted.body);
      assert.deepEqual(restricted.json().restriction, {
        agreementId: id,
        version: 2,
        hasRemainingAssignment: true,
      });
      assert.equal(
        (await client.request(releaseUrl, releaseBody, releaseHeaders))
          .statusCode,
        409,
      );
      assert.equal(
        (
          await client.request(
            releaseUrl,
            { ...releaseBody, reason: " " },
            releaseHeaders,
          )
        ).statusCode,
        400,
      );
      assert.equal(
        (
          await client.request(
            releaseUrl,
            { ...releaseBody, published: true },
            releaseHeaders,
          )
        ).statusCode,
        400,
      );
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: releaseUrl,
            payload: releaseBody,
            headers: {
              ...releaseHeaders,
              cookie: client.cookie(),
              origin: "https://foreign.invalid",
            },
          })
        ).statusCode,
        403,
      );

      assert.equal(activated.headers["cache-control"], "no-store");
      const activationReplay = await replica.inject({
        method: "POST",
        url: activateUrl,
        payload: activateBody,
        headers: {
          ...activateHeaders,
          origin: config.origin,
          cookie: client.cookie(),
        },
      });
      assert.equal(activationReplay.statusCode, 200, activationReplay.body);
      assert.equal(activationReplay.headers["idempotency-replayed"], "true");
      assert.deepEqual(activationReplay.json(), activated.json());
      assert.equal(
        (
          await client.request(activateUrl, activateBody, {
            "idempotency-key": "another-activation",
          })
        ).statusCode,
        409,
      );
      assert.equal((await client.request(detailUrl)).json().status, "ACTIVADO");
      assert.equal(
        (
          await client.request(
            credentialUrl,
            { ...credentialBody, accountId: "foreign-account" },
            credentialHeaders,
          )
        ).statusCode,
        404,
      );
      assert.equal(
        (
          await client.request(
            credentialUrl,
            { ...credentialBody, subjectId: randomUUID() },
            credentialHeaders,
          )
        ).statusCode,
        400,
      );
      assert.equal(
        (
          await client.request(credentialUrl, credentialBody, {
            ...credentialHeaders,
            origin: "https://external.test",
          })
        ).statusCode,
        403,
      );
      const issued = await client.request(
        credentialUrl,
        credentialBody,
        credentialHeaders,
      );
      assert.equal(issued.statusCode, 201, issued.body);
      assert.equal(issued.json().revoked, false);
      assert.equal(issued.headers["cache-control"], "no-store");
      const credentialReplay = await replica.inject({
        method: "POST",
        url: credentialUrl,
        payload: credentialBody,
        headers: {
          ...credentialHeaders,
          origin: config.origin,
          cookie: client.cookie(),
        },
      });
      assert.equal(credentialReplay.statusCode, 201, credentialReplay.body);
      assert.equal(credentialReplay.headers["idempotency-replayed"], "true");
      assert.deepEqual(credentialReplay.json(), issued.json());
      const revokeUrl = `${credentialUrl}/${issued.json().id}/revoke`;
      const revokeBody = { reason: "Verification withdrawn" },
        revokeHeaders = { "idempotency-key": "http-revoke" };
      assert.equal(
        (await client.request(revokeUrl, { reason: " " }, revokeHeaders))
          .statusCode,
        400,
      );
      const suspensionUrl = `${url}/${id}/suspend`;
      const suspensionBody = { version: 2, reason: "Safety review" },
        suspensionHeaders = { "idempotency-key": "http-suspend" };
      assert.equal(
        (
          await client.request(
            suspensionUrl,
            { version: 2, reason: " " },
            suspensionHeaders,
          )
        ).statusCode,
        400,
      );
      const suspended = await client.request(
        suspensionUrl,
        suspensionBody,
        suspensionHeaders,
      );
      assert.equal(suspended.statusCode, 200, suspended.body);
      assert.equal(suspended.json().status, "SUSPENDIDO");
      const suspensionReplay = await replica.inject({
        method: "POST",
        url: suspensionUrl,
        payload: suspensionBody,
        headers: {
          ...suspensionHeaders,
          origin: config.origin,
          cookie: client.cookie(),
        },
      });
      assert.equal(suspensionReplay.statusCode, 200, suspensionReplay.body);
      assert.equal(suspensionReplay.headers["idempotency-replayed"], "true");

      const revoked = await client.request(
        revokeUrl,
        revokeBody,
        revokeHeaders,
      );
      assert.equal(revoked.statusCode, 200, revoked.body);
      assert.equal(revoked.json().revoked, true);
      const revokedReplay = await replica.inject({
        method: "POST",
        url: revokeUrl,
        payload: revokeBody,
        headers: {
          ...revokeHeaders,
          origin: config.origin,
          cookie: client.cookie(),
        },
      });
      assert.equal(revokedReplay.statusCode, 200, revokedReplay.body);
      assert.equal(revokedReplay.headers["idempotency-replayed"], "true");
      assert.deepEqual(revokedReplay.json(), revoked.json());
      assert.equal((await client.request(credentialUrl)).statusCode, 404);
      const released = await client.request(
        releaseUrl,
        releaseBody,
        releaseHeaders,
      );
      assert.equal(released.statusCode, 200, released.body);
      assert.deepEqual(released.json(), { unitId: unit, removed: true });
      assert.equal(released.headers["cache-control"], "no-store");
      const releaseReplay = await replica.inject({
        method: "POST",
        url: releaseUrl,
        payload: releaseBody,
        headers: {
          ...releaseHeaders,
          origin: config.origin,
          cookie: client.cookie(),
        },
      });
      assert.equal(releaseReplay.statusCode, 200, releaseReplay.body);
      assert.equal(releaseReplay.headers["idempotency-replayed"], "true");
      assert.deepEqual(releaseReplay.json(), released.json());
      assert.equal(
        (await client.request(restrictionUrl)).json().restriction,
        null,
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
      assert.equal(
        (await client.request(credentialUrl, credentialBody, credentialHeaders))
          .statusCode,
        403,
      );
      assert.equal(
        (await client.request(revokeUrl, revokeBody, revokeHeaders)).statusCode,
        403,
      );
      assert.equal(
        (await client.request(suspensionUrl, suspensionBody, suspensionHeaders))
          .statusCode,
        403,
      );
      assert.equal(
        (await client.request(activateUrl, activateBody, activateHeaders))
          .statusCode,
        403,
      );
      assert.equal(
        (await client.request(releaseUrl, releaseBody, releaseHeaders))
          .statusCode,
        403,
      );
      assert.equal((await client.request(restrictionUrl)).statusCode, 403);
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
        "/api/municipalities/{tenantId}/agreements/{agreementId}/suspend",
        "/api/municipalities/{tenantId}/agreements/{agreementId}/activate",
        "/api/municipalities/{tenantId}/units/{unitId}/agreement-restriction",
        "/api/municipalities/{tenantId}/units/{unitId}/agreement-restriction/release",
        "/api/municipalities/{tenantId}/credentials",
        "/api/municipalities/{tenantId}/credentials/{credentialId}/revoke",
      ])
        assert.ok(spec.paths[path]);
    } finally {
      await app.close();
      await replica.close();
    }
  });
});
