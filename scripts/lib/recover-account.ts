import { randomUUID } from "node:crypto";
import type { Client } from "pg";
export interface AccountRecoveryEvidence {
  performedBy: string;
  identityReference: string;
  remediationReference: string;
  reason: string;
}
// Evidence is verified by the operational procedure, not by a free-text API.
export async function recoverAccount(
  client: Client,
  accountId: string,
  evidence: AccountRecoveryEvidence,
): Promise<void> {
  if (
    !accountId ||
    accountId.length > 128 ||
    accountId.includes("\0") ||
    Object.values(evidence).some(
      (value) => !value.trim() || value.length > 500 || value.includes("\0"),
    )
  )
    throw new Error("Verified identity and remediation evidence are required");
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    const result = await client.query<{ recovered_at: Date | null }>(
      "SELECT auth.recover_account($1,$2,$3,$4,$5,$6) AS recovered_at",
      [
        accountId,
        evidence.performedBy.trim(),
        evidence.identityReference.trim(),
        evidence.remediationReference.trim(),
        evidence.reason.trim(),
        randomUUID(),
      ],
    );
    if (!result.rows[0]?.recovered_at)
      throw new Error("No retained inactive account to recover");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
