import type { Pool } from "pg";

export async function consumeAdministrativeAttempt(
  pool: Pool,
  accountId: string,
): Promise<{ allowed: boolean; retryAfter: number }> {
  // Autocommit: the attempt survives rejection/rollback of the business command.
  const result = await pool.query<{ allowed: boolean; retry_after: number }>(
    "SELECT allowed, retry_after FROM domain.consume_administrative_attempt($1)",
    [accountId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Missing rate-limit decision");
  return { allowed: row.allowed, retryAfter: row.retry_after };
}
