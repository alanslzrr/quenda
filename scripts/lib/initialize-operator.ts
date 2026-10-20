import type { Client } from "pg";

// Explicit maintenance operation; never exposed as an HTTP registration route.
export async function initializeOperator(
  client: Client,
  accountId: string,
): Promise<void> {
  if (!accountId || accountId.includes("\0"))
    throw new Error("Invalid account identifier");
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    await client.query("SELECT pg_advisory_xact_lock(7100182601)");
    const initialized = await client.query(
      "SELECT 1 FROM domain.operator_initialization",
    );
    if (initialized.rowCount)
      throw new Error("Operator initialization already completed");
    const account = await client.query<{
      emailVerified: boolean;
      twoFactorEnabled: boolean;
      enabled: boolean;
    }>(
      'SELECT u."emailVerified", u."twoFactorEnabled", domain.responsible_account_enabled(u.id) AS enabled FROM auth."user" u JOIN auth.account_lifecycle l ON l.account_id=u.id WHERE u.id = $1 FOR SHARE OF l,u',
      [accountId],
    );
    if (
      !account.rows[0]?.emailVerified ||
      !account.rows[0].twoFactorEnabled ||
      !account.rows[0].enabled
    )
      throw new Error("Operator requires a verified account with MFA enabled");
    await client.query(
      "INSERT INTO domain.platform_operator (account_id) VALUES ($1)",
      [accountId],
    );
    await client.query(
      "INSERT INTO domain.operator_initialization (account_id) VALUES ($1)",
      [accountId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
