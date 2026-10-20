import type { Pool } from "pg";
import { command } from "../../database/command.ts";

export interface RetentionBatchResult {
  processed: number;
  conflicts: number;
  examined: number;
}

/** No actor identity is impersonated: only the dedicated worker may execute. */
export async function processRetentionBatch(
  pool: Pool,
  limit = 10,
): Promise<RetentionBatchResult> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new Error("Invalid retention batch size");
  return command(pool, undefined, async (client) => {
    const row = (
      await client.query<{ result: RetentionBatchResult }>(
        "SELECT domain.process_retention_batch($1) AS result",
        [limit],
      )
    ).rows[0];
    if (!row) throw new Error("Missing retention result");
    return row.result;
  });
}
