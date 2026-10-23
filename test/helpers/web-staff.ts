import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { browser, totp } from "./auth-client.ts";

// Verified, MFA-enabled recipients without municipal authority. Browser actions
// create and accept every grant exercised by the staff journeys.
export async function seedStaffRecipient(
  app: FastifyInstance,
  auth: Pool,
  index: number,
) {
  const client = browser(
    app,
    `192.0.2.${210 + index}`,
    "http://127.0.0.1:5173",
  );
  const email = `staff-${index}@example.test`,
    password = "Synthetic-password-1234!";
  const signup = await client.request("/api/auth/sign-up/email", {
    email,
    password,
    name: `Personal ${index}`,
  });
  assert.equal(signup.statusCode, 200, signup.body);
  const accountId: string = signup.json().user.id;
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
  const verification = await client.request(
    "/api/auth/two-factor/verify-totp",
    { code: totp(secret) },
  );
  assert.equal(verification.statusCode, 200, verification.body);
  return { accountId, email, password, secret };
}
