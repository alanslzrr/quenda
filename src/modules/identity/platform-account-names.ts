import type { PoolClient } from "pg";

export const accountNameSchema = { type: "string", nullable: true } as const;

/**
 * Names only, one bounded query per page; the database rechecks operator
 * authority. A missing id (an invitation addressed only to an email) is
 * skipped.
 */
export async function platformAccountNames(
  client: PoolClient,
  ids: (string | null | undefined)[],
) {
  const accounts = [
    ...new Set(ids.filter((id): id is string => typeof id === "string")),
  ];
  if (!accounts.length) return new Map<string, string>();
  const result = await client.query<{ account_id: string; name: string }>(
    "SELECT account_id,name FROM domain.platform_account_names($1::text[])",
    [accounts],
  );
  return new Map(result.rows.map((row) => [row.account_id, row.name]));
}
