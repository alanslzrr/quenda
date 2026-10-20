import { randomInt } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { DatabaseError, type Pool, type PoolClient } from "pg";
import type { TransactionContext } from "./context.ts";
import { beginCommandMeasurement } from "./metrics.ts";
import { transaction } from "./transaction.ts";

// The callback must redo authorization and all reads on every attempt. External
// effects belong in the transactional outbox, not in this retried callback.
export async function command<T>(
  pool: Pool,
  context: TransactionContext | undefined,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const measurement = beginCommandMeasurement(pool);
  let committed = false;
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await transaction(pool, operation, context);
        committed = true;
        return result;
      } catch (error) {
        const code = error instanceof DatabaseError ? error.code : undefined;
        const retry = attempt < 2 && (code === "40001" || code === "40P01");
        measurement.conflict(code, retry);
        if (!retry) throw error;
        // The transaction releases its connection before this bounded backoff.
        await setTimeout(randomInt(10, 31) * 2 ** attempt);
      }
    }
  } finally {
    measurement.finish(committed);
  }
}
