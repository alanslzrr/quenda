import type { Client } from "pg";
import { scramVerifier } from "./scram-verifier.ts";

// Upgrade a dedicated Quenda database; never replace an existing cluster role.
export async function provisionWorker(client: Client, password: string) {
  if (password.length < 24 || password.includes("\0"))
    throw new Error("Invalid worker password");
  const verifier = scramVerifier(password);
  await client.query("BEGIN");
  try {
    const schemas = await client.query<{ name: string }>(
      "SELECT n.nspname AS name FROM pg_namespace n JOIN pg_roles r ON r.oid=n.nspowner WHERE n.nspname IN ('domain','auth','extensions','quenda_meta') AND r.rolname='quenda_migrator'",
    );
    if (schemas.rowCount !== 4) throw new Error("Not a Quenda database");
    const statements = await client.query<{
      create_role: string;
      connect: string;
    }>(
      "SELECT format('CREATE ROLE quenda_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD %L', $1::text) AS create_role, format('GRANT CONNECT ON DATABASE %I TO quenda_worker', current_database()) AS connect",
      [verifier],
    );
    const row = statements.rows[0];
    if (!row) throw new Error("Missing database");
    await client.query(row.create_role);
    await client.query(row.connect);
    await client.query("GRANT USAGE ON SCHEMA domain TO quenda_worker");
    await client.query(
      "ALTER ROLE quenda_worker SET search_path = pg_catalog, domain",
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
