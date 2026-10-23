import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { createReservation } from "../../src/modules/reservations/create.ts";
import { browser, totp } from "./auth-client.ts";
import { initialAcceptance } from "./usage-rules-fixture.ts";
import { browserCatalog, seedWebCatalog } from "./web-catalog.ts";

// Synthetic accounts and grants belong only to the ephemeral browser-test DB.
export async function seedMunicipalBrowser(
  app: FastifyInstance,
  auth: Pool,
  domain: Pool,
  migration: Pool,
  index: number,
) {
  const catalog = browserCatalog(index + 4);
  await seedWebCatalog(auth, migration, catalog);
  const client = browser(
    app,
    `192.0.2.${180 + index}`,
    "http://127.0.0.1:5173",
  );
  const email = `municipal-${index}@example.test`,
    password = "Synthetic-password-1234!";
  const signup = await client.request("/api/auth/sign-up/email", {
    email,
    password,
    name: `Administrador ${index}`,
  });
  assert.equal(signup.statusCode, 200, signup.body);
  const accountId = signup.json().user.id;
  await auth.query('UPDATE auth."user" SET "emailVerified"=true WHERE id=$1', [
    accountId,
  ]);
  assert.equal(
    (await client.request("/api/auth/sign-in/email", { email, password }))
      .statusCode,
    200,
  );
  const enrollment = await client.request("/api/auth/two-factor/enable", {
    password,
  });
  assert.equal(enrollment.statusCode, 200, enrollment.body);
  const secret = new URL(enrollment.json().totpURI).searchParams.get("secret");
  assert.ok(secret);
  const verified = await client.request("/api/auth/two-factor/verify-totp", {
    code: totp(secret),
  });
  assert.equal(verified.statusCode, 200, verified.body);
  const invitation = randomUUID();
  await migration.query(
    "INSERT INTO domain.municipal_profile(tenant_id,account_id) VALUES($1,$2)",
    [catalog.tenant, accountId],
  );
  await migration.query(
    "INSERT INTO domain.administrator_invitation(tenant_id,id,account_id,invited_by,expires_at,accepted_at) VALUES($1,$2,$3,$3,now()+interval '1 day',now())",
    [catalog.tenant, invitation, accountId],
  );
  await migration.query(
    "INSERT INTO domain.municipal_administrator(tenant_id,account_id,invitation_id) VALUES($1,$2,$3)",
    [catalog.tenant, accountId, invitation],
  );
  const date = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  const reservation = (
    await createReservation(
      domain,
      {
        accountId: "web-fixture",
        email: "fixture@example.test",
        sessionId: "synthetic",
        mfaVerifiedAt: null,
      },
      catalog.tenant,
      randomUUID(),
      {
        unitId: catalog.unit,
        startsAt: `${date}T10:00:00Z`,
        endsAt: `${date}T11:00:00Z`,
        acceptance: initialAcceptance,
      },
      randomUUID(),
      3600,
    )
  ).result;
  return {
    ...catalog,
    accountId,
    email,
    password,
    secret,
    date,
    reservationId: reservation.id,
  };
}
