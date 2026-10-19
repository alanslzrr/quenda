import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Client } from "pg";

export async function migrate(
  client: Client,
  directory: string,
): Promise<string[]> {
  const role = await client.query<{ current_user: string }>(
    "SELECT current_user",
  );
  if (role.rows[0]?.current_user !== "quenda_migrator")
    throw new Error("Use the migration role");
  await client.query("SELECT pg_advisory_lock(hashtext('quenda:migrations'))");
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS quenda_meta.migrations (
      filename text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const files = (await readdir(directory))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    if (files.some((name) => !/^\d{4}_[a-z0-9_]+\.sql$/.test(name)))
      throw new Error("Invalid migration filename");
    const applied = await client.query<{ filename: string; sha256: string }>(
      "SELECT filename, sha256 FROM quenda_meta.migrations ORDER BY filename",
    );
    const sources = await Promise.all(
      files.map(async (filename) => {
        const sql = await readFile(join(directory, filename), "utf8");
        return {
          filename,
          sql,
          hash: createHash("sha256").update(sql).digest("hex"),
        };
      }),
    );
    for (const [index, previous] of applied.rows.entries()) {
      const source = sources[index];
      if (
        source?.filename !== previous.filename ||
        source.hash !== previous.sha256
      ) {
        throw new Error(
          "Applied migrations must not be removed, reordered or modified",
        );
      }
    }
    const completed: string[] = [];
    for (const source of sources.slice(applied.rows.length)) {
      await client.query("BEGIN");
      try {
        await client.query(source.sql);
        await client.query(
          "INSERT INTO quenda_meta.migrations (filename, sha256) VALUES ($1, $2)",
          [source.filename, source.hash],
        );
        await client.query("COMMIT");
        completed.push(source.filename);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    return completed;
  } finally {
    await client.query(
      "SELECT pg_advisory_unlock(hashtext('quenda:migrations'))",
    );
  }
}
