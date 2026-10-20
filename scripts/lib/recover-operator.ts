import { randomUUID } from "node:crypto";
import type { Client } from "pg";

export interface OperatorRecoveryEvidence {
  performedBy: string;
  authorityReference: string;
  reason: string;
}

// This maintenance credential cannot be obtained through the web API. The
// authority reference points to an independently verified operational record;
// recording a reference does not itself verify the claimant's authority.
export async function recoverOperator(
  client: Client,
  accountId: string,
  evidence: OperatorRecoveryEvidence,
): Promise<void> {
  if (
    !accountId ||
    accountId.length > 128 ||
    accountId.includes("\0") ||
    Object.values(evidence).some(
      (value) => !value.trim() || value.length > 500 || value.includes("\0"),
    )
  )
    throw new Error("Account and verified recovery evidence are required");
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    await client.query("SELECT pg_advisory_xact_lock(7100182601)");
    const initialized = await client.query(
      "SELECT 1 FROM domain.operator_initialization",
    );
    if (!initialized.rowCount)
      throw new Error("Initialize the first operator before recovery");
    const current = await client.query(
      "SELECT 1 FROM domain.platform_operator p WHERE p.revoked_at IS NULL AND domain.responsible_account_enabled(p.account_id)",
    );
    if (current.rowCount)
      throw new Error("An enabled operator must use the ordinary handover API");
    const destination = await client.query<{ enabled: boolean }>(
      'SELECT domain.responsible_account_enabled(l.account_id) AS enabled FROM auth.account_lifecycle l JOIN auth."user" u ON u.id=l.account_id WHERE l.account_id=$1 FOR SHARE OF l,u',
      [accountId],
    );
    if (!destination.rows[0]?.enabled)
      throw new Error(
        "Recovery requires an active verified account with MFA enabled",
      );
    const previous = await client.query(
      "SELECT account_id FROM domain.platform_operator WHERE account_id=$1 FOR UPDATE",
      [accountId],
    );
    if (previous.rowCount) {
      await client.query(
        "UPDATE domain.platform_operator SET created_at=clock_timestamp(),revoked_at=NULL WHERE account_id=$1",
        [accountId],
      );
    } else {
      await client.query(
        "INSERT INTO domain.platform_operator(account_id) VALUES($1)",
        [accountId],
      );
    }
    await client.query(
      "INSERT INTO domain.platform_operator_event(id,operational_actor,operation,subject_id,reason,authority_reference) VALUES($1,$2,'RECOVER_OPERATOR',$3,$4,$5)",
      [
        randomUUID(),
        evidence.performedBy.trim(),
        accountId,
        evidence.reason.trim(),
        evidence.authorityReference.trim(),
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
