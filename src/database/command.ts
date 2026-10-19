import { randomInt } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { DatabaseError, type Pool, type PoolClient } from "pg";
import type { TransactionContext } from "./context.ts";
import { transaction } from "./transaction.ts";

// The callback must redo authorization and all reads on every attempt. External
// effects belong in the transactional outbox, not in this retried callback.
export async function command<T>(
  pool: Pool,
  context: TransactionContext,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await transaction(pool, operation, context);
    } catch (error) {
      if (
        attempt >= 2 ||
        !(error instanceof DatabaseError) ||
        !["40001", "40P01"].includes(error.code ?? "")
      )
        throw error;
      // Release the connection before waiting. Connection loss, constraints and
      // domain errors are not retries: their outcome or meaning differs.
      await setTimeout(randomInt(10, 31) * 2 ** attempt);
    }
  }
}
