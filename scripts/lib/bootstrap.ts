import type { Client } from "pg";

export interface DatabasePasswords {
  migration: string;
  domain: string;
  auth: string;
}

// Run only against a new, dedicated database with an administrative connection.
// Existing roles or schemas cause the transaction to fail; they are never replaced.
export async function bootstrap(
  client: Client,
  passwords: DatabasePasswords,
): Promise<void> {
  if (Object.values(passwords).some((p) => p.length < 24))
    throw new Error("Passwords must have at least 24 characters");
  if (new Set(Object.values(passwords)).size !== 3)
    throw new Error("Passwords must differ");
  await client.query("BEGIN");
  try {
    for (const [name, password] of [
      ["quenda_migrator", passwords.migration],
      ["quenda_domain", passwords.domain],
      ["quenda_auth", passwords.auth],
    ]) {
      const formatted = await client.query<{ sql: string }>(
        "SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD %L', $1::text, $2::text) AS sql",
        [name, password],
      );
      await client.query(formatted.rows[0]?.sql ?? "");
    }
    const commands = await client.query<{
      revoke: string;
      connect: string;
      create: string;
    }>(`
      SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database()) AS revoke,
        format('GRANT CONNECT ON DATABASE %I TO quenda_domain, quenda_auth, quenda_migrator', current_database()) AS connect,
        format('GRANT CREATE ON DATABASE %I TO quenda_migrator', current_database()) AS create
    `);
    const row = commands.rows[0];
    if (!row) throw new Error("Missing database");
    await client.query(row.revoke);
    await client.query(row.connect);
    await client.query(row.create);
    await client.query(`
      REVOKE ALL ON SCHEMA public FROM PUBLIC;
      CREATE SCHEMA domain AUTHORIZATION quenda_migrator;
      CREATE SCHEMA auth AUTHORIZATION quenda_migrator;
      CREATE SCHEMA extensions AUTHORIZATION quenda_migrator;
      CREATE SCHEMA quenda_meta AUTHORIZATION quenda_migrator;
      GRANT USAGE ON SCHEMA domain, extensions TO quenda_domain;
      GRANT USAGE ON SCHEMA auth TO quenda_auth;
      ALTER ROLE quenda_domain SET search_path = pg_catalog, domain, extensions;
      ALTER ROLE quenda_auth SET search_path = pg_catalog, auth;
      ALTER ROLE quenda_migrator SET search_path = pg_catalog, domain, extensions;
      ALTER DEFAULT PRIVILEGES FOR ROLE quenda_migrator REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
    `);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
