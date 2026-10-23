import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import {
  acceptOperatorInvitation,
  inviteOperator,
} from "../../src/modules/identity/operator-lifecycle.ts";
import { seedStaffRecipient } from "./web-staff.ts";
// Each journey owns two verified identities. Only its initial operator grant is
// seeded; municipalities, invitations and security changes run through the UI.
export async function seedPlatformBrowser(
  app: FastifyInstance,
  auth: Pool,
  domain: Pool,
  index: number,
  issuer: string,
) {
  const operator = await seedStaffRecipient(app, auth, index);
  const recipient = await seedStaffRecipient(app, auth, index + 1);
  const actor = (accountId: string) => ({
    accountId,
    email: `${accountId}@example.test`,
    sessionId: "synthetic-platform-fixture",
    mfaVerifiedAt: new Date(),
  });
  const invitation = await inviteOperator(domain, actor(issuer), {
    accountId: operator.accountId,
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  });
  await acceptOperatorInvitation(
    domain,
    actor(operator.accountId),
    invitation.invitationId,
  );
  return { operator, recipient };
}
