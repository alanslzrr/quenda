import { Pool } from "pg";
import type { Config } from "../config.ts";

export interface DatabaseHealth {
  check(): Promise<void>;
  close(): Promise<void>;
}

export async function assertRuntimeRole(pool: Pool): Promise<void> {
  const result = await pool.query<{ unsafe: boolean }>(`
    SELECT (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb
      OR EXISTS (SELECT 1 FROM pg_roles inherited
        WHERE (inherited.rolsuper OR inherited.rolbypassrls OR inherited.rolcreaterole OR inherited.rolcreatedb)
        AND pg_has_role(current_user, inherited.oid, 'MEMBER'))
      OR EXISTS (SELECT 1 FROM pg_namespace n
        WHERE n.nspname IN ('domain', 'auth', 'quenda_meta', 'extensions')
        AND pg_has_role(current_user, n.nspowner, 'MEMBER'))
      OR EXISTS (SELECT 1 FROM pg_database d WHERE d.datname = current_database()
        AND pg_has_role(current_user, d.datdba, 'MEMBER'))) AS unsafe
    FROM pg_roles WHERE rolname = current_user
  `);
  if (result.rows.length !== 1 || result.rows[0]?.unsafe)
    throw new Error("Unsafe database role");
}

export async function assertPrivacyOperational(pool: Pool): Promise<void> {
  const privacy = await pool.query<{ ready: boolean }>(
    "SELECT domain.privacy_operational() AS ready",
  );
  if (privacy.rows[0]?.ready !== true)
    throw new Error("Privacy recovery review required");
}

export function createDatabases(config: Config) {
  const makePool = (connectionString: string) => {
    const pool = new Pool({
      connectionString,
      max: config.databasePoolMax,
      connectionTimeoutMillis: 3000,
      idleTimeoutMillis: 30000,
      statement_timeout: 5000,
      application_name: "quenda-backend",
    });
    // An idle connection failure must not become an unhandled EventEmitter error.
    pool.on("error", () => {
      process.stderr.write("Database connection unavailable\n");
    });
    return pool;
  };
  const domain = makePool(config.domainDatabaseUrl);
  const auth = makePool(config.authDatabaseUrl);
  return {
    domain,
    auth,
    async check() {
      await Promise.all([assertRuntimeRole(domain), assertRuntimeRole(auth)]);
      await assertPrivacyOperational(domain);
    },
    async close() {
      await Promise.all([domain.end(), auth.end()]);
    },
  };
}
