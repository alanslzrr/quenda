import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Client, PoolClient } from "pg";
import { validMailbox } from "../../src/mail/config.ts";
import { sendEmailChangeLink } from "../../src/modules/identity/email-change.ts";
import type { MailTransport } from "../../src/shared/mail.ts";

export interface EmailRecoveryEvidence {
  performedBy: string;
  identityReference: string;
  reason: string;
}
// Only the separate maintenance login can issue this challenge. The controlled
// procedure verifies the referenced evidence before invoking the command.
export async function recoverEmail(
  client: Client | PoolClient,
  accountId: string,
  newEmail: string,
  evidence: EmailRecoveryEvidence,
  mail: MailTransport,
  origin: string,
): Promise<void> {
  const email = newEmail.trim().toLowerCase();
  const url = new URL(origin);
  if (
    !accountId ||
    accountId.length > 128 ||
    accountId.includes("\0") ||
    !validMailbox(email) ||
    url.protocol !== "https:" ||
    url.origin !== origin ||
    Object.values(evidence).some(
      (v) => !v.trim() || v.length > 500 || v.includes("\0"),
    )
  )
    throw new Error("Verified identity and valid email configuration required");
  const token = randomBytes(32).toString("base64url");
  let challenge: string | undefined;
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    const result = await client.query<{ challenge: string | null }>(
      "SELECT auth.issue_assisted_email_change($1,$2,$3,$4,$5,$6,$7) AS challenge",
      [
        accountId,
        email,
        createHash("sha256").update(token).digest("hex"),
        evidence.performedBy.trim(),
        evidence.identityReference.trim(),
        evidence.reason.trim(),
        randomUUID(),
      ],
    );
    challenge = result.rows[0]?.challenge ?? undefined;
    if (!challenge)
      throw new Error(
        "No active retained identity eligible for email recovery",
      );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  try {
    await sendEmailChangeLink(mail, origin, email, token, "confirm");
  } catch {
    await client.query("SELECT auth.revoke_email_change($1)", [challenge]);
    throw new Error("Delivery failed; recovery challenge revoked");
  }
}
