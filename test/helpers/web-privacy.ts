import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { initializeOperator } from "../../scripts/lib/initialize-operator.ts";
import {
  acceptManager,
  inviteManager,
} from "../../src/modules/identity/manager.ts";
import {
  acceptGlobalPrivacy,
  inviteGlobalPrivacy,
} from "../../src/modules/identity/privacy-permissions.ts";
import { seedMunicipalBrowser } from "./web-municipal.ts";
export async function seedPrivacyBrowser(
  app: FastifyInstance,
  auth: Pool,
  domain: Pool,
  migration: Pool,
  index: number,
  operator?: string,
) {
  const f = await seedMunicipalBrowser(app, auth, domain, migration, index);
  const actor = (accountId: string) => ({
    accountId,
    email: `${accountId}@example.test`,
    sessionId: "synthetic-privacy-fixture",
    mfaVerifiedAt: new Date(),
  });
  const expiresAt = new Date(Date.now() + 86400000).toISOString();
  const grant = await inviteManager(domain, actor(f.accountId), f.tenant, {
    email: f.email,
    expiresAt,
    permissions: [
      { operation: "PRIVACY_READ", unitId: null },
      { operation: "PRIVACY_EXECUTE", unitId: null },
    ],
  });
  await acceptManager(domain, actor(f.accountId), f.tenant, grant.invitationId);
  if (!operator) {
    const client = await migration.connect();
    try {
      await initializeOperator(client, f.accountId);
    } finally {
      client.release();
    }
  }
  const globalGrant = await inviteGlobalPrivacy(
    domain,
    actor(operator ?? f.accountId),
    {
      accountId: f.accountId,
      expiresAt,
      permissions: ["PRIVACY_READ", "PRIVACY_EXECUTE"],
      reason: "Synthetic browser grant",
    },
  );
  await acceptGlobalPrivacy(
    domain,
    actor(f.accountId),
    globalGrant.invitationId,
  );
  const subject = `privacy-target-${randomUUID()}`;
  await auth.query(
    'INSERT INTO auth."user"(id,name,email,"emailVerified","updatedAt") VALUES($1,$1,$2,true,now())',
    [subject, `${subject}@example.test`],
  );
  await migration.query(
    "INSERT INTO domain.municipal_profile(tenant_id,account_id) VALUES($1,$2)",
    [f.tenant, subject],
  );
  return { ...f, subject };
}
