import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { seedMunicipalBrowser } from "./web-municipal.ts";

// A municipal administrator who also administers an empty municipality, so the
// catalog exported from one can be imported into the other.
export async function seedImportBrowser(
  app: FastifyInstance,
  auth: Pool,
  domain: Pool,
  migration: Pool,
  index: number,
) {
  const source = await seedMunicipalBrowser(
    app,
    auth,
    domain,
    migration,
    index,
  );
  const target = randomUUID();
  await migration.query(
    "INSERT INTO domain.municipality(id,name,timezone) VALUES($1,$2,'Europe/Madrid')",
    [target, `Destino ${index}`],
  );
  const invitation = randomUUID();
  await migration.query(
    "INSERT INTO domain.municipal_profile(tenant_id,account_id) VALUES($1,$2)",
    [target, source.accountId],
  );
  await migration.query(
    "INSERT INTO domain.administrator_invitation(tenant_id,id,account_id,invited_by,expires_at,accepted_at) VALUES($1,$2,$3,$3,now()+interval '1 day',now())",
    [target, invitation, source.accountId],
  );
  await migration.query(
    "INSERT INTO domain.municipal_administrator(tenant_id,account_id,invitation_id) VALUES($1,$2,$3)",
    [target, source.accountId, invitation],
  );
  return { ...source, target };
}
