import type { PoolClient } from "pg";

export const accountLabelSchema = {
  type: "object",
  nullable: true,
  additionalProperties: false,
  required: ["name", "email"],
  properties: { name: { type: "string" }, email: { type: "string" } },
} as const;

/** One bounded query per page; the database rechecks municipal authority. */
export async function accountLabels(client: PoolClient, ids: string[]) {
  const result = await client.query<{
    account_id: string;
    name: string;
    email: string;
  }>(
    "SELECT account_id,name,email FROM domain.municipal_account_labels($1::text[])",
    [[...new Set(ids)]],
  );
  return new Map(
    result.rows.map((row) => [
      row.account_id,
      { name: row.name, email: row.email },
    ]),
  );
}
