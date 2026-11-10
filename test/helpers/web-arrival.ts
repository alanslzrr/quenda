import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { transaction } from "../../src/database/transaction.ts";
import { browser } from "./auth-client.ts";
import { seedMunicipalBrowser } from "./web-municipal.ts";

// A holder with a reservation that starts 20 minutes after the test server
// starts, so the access window is already open while the suite runs.
export async function seedArrivalBrowser(
  app: FastifyInstance,
  auth: Pool,
  domain: Pool,
  migration: Pool,
  index: number,
) {
  const administrator = await seedMunicipalBrowser(
    app,
    auth,
    domain,
    migration,
    index,
  );
  const client = browser(
    app,
    `2001:db8:520:${index}::1`,
    "http://127.0.0.1:5173",
  );
  const email = `arrival-${index}@example.test`,
    password = "Synthetic-password-1234!";
  const signup = await client.request("/api/auth/sign-up/email", {
    email,
    password,
    name: `Titular ${index}`,
  });
  assert.equal(signup.statusCode, 200, signup.body);
  const accountId: string = signup.json().user.id;
  await auth.query('UPDATE auth."user" SET "emailVerified"=true WHERE id=$1', [
    accountId,
  ]);
  await migration.query(
    "INSERT INTO domain.municipal_profile(tenant_id,account_id) VALUES($1,$2)",
    [administrator.tenant, accountId],
  );
  const reservationId = randomUUID();
  await transaction(migration, async (connection) => {
    await connection.query(
      `INSERT INTO domain.reservation(tenant_id,id,account_id,unit_id,calendar_version,starts_at,ends_at,status,cancellation_minutes,timezone)
       VALUES($1,$2,$3,$4,1,date_trunc('minute',now())+interval '20 minutes',date_trunc('minute',now())+interval '80 minutes','CONFIRMADA',0,'Europe/Madrid')`,
      [administrator.tenant, reservationId, accountId, administrator.otherUnit],
    );
    await connection.query(
      "INSERT INTO domain.occupancy(tenant_id,id,unit_id,reservation_id,period) SELECT tenant_id,gen_random_uuid(),unit_id,id,tstzrange(starts_at,ends_at,'[)') FROM domain.reservation WHERE tenant_id=$1 AND id=$2",
      [administrator.tenant, reservationId],
    );
    await connection.query(
      "INSERT INTO domain.reservation_event(tenant_id,id,reservation_id,revision,kind,actor_id,correlation_id,after_state) SELECT tenant_id,gen_random_uuid(),id,1,'CONFIRMADA',account_id,gen_random_uuid(),domain.reservation_snapshot(r) FROM domain.reservation r WHERE tenant_id=$1 AND id=$2",
      [administrator.tenant, reservationId],
    );
  });
  return {
    administrator,
    holder: { accountId, email, password },
    reservationId,
  };
}
