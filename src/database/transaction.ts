import type { Pool, PoolClient } from "pg";
import { setTransactionContext, type TransactionContext } from "./context.ts";

export async function transaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
  context?: TransactionContext,
): Promise<T> {
  const client = await pool.connect();
  let damaged = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await setTransactionContext(client, context);
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      damaged = true;
      throw new AggregateError(
        [error, rollbackError],
        "Transaction rollback failed",
      );
    }
    throw error;
  } finally {
    client.release(damaged);
  }
}
