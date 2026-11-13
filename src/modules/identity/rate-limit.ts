import type { Pool } from "pg";

async function consume(
  pool: Pool,
  bucket: "administrative" | "read",
  accountId: string,
): Promise<{ allowed: boolean; retryAfter: number }> {
  // Autocommit: the attempt survives rejection/rollback of the business command.
  const result = await pool.query<{ allowed: boolean; retry_after: number }>(
    bucket === "read"
      ? "SELECT allowed, retry_after FROM domain.consume_read_attempt($1)"
      : "SELECT allowed, retry_after FROM domain.consume_administrative_attempt($1)",
    [accountId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Missing rate-limit decision");
  return { allowed: row.allowed, retryAfter: row.retry_after };
}

/** Commands that change data: 120 per account and minute. */
export const consumeAdministrativeAttempt = (pool: Pool, accountId: string) =>
  consume(pool, "administrative", accountId);

/** Authenticated reads: 600 per account and minute, apart from the command budget. */
export const consumeReadAttempt = (pool: Pool, accountId: string) =>
  consume(pool, "read", accountId);
