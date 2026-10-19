import type { Pool, PoolClient } from "pg";

export async function transaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let damaged = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      damaged = true;
    }
    throw error;
  } finally {
    client.release(damaged);
  }
}
