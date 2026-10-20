import type { PoolClient } from "pg";
import { HttpError } from "../http/errors.ts";

// Constructed by application services from a verified session and an authorized
// scope, never by spreading HTTP input. Context does not grant permissions.
export interface TransactionContext {
  readonly accountId: string;
  readonly tenantId: string | null;
}

export async function setTransactionContext(
  client: PoolClient,
  context?: TransactionContext,
): Promise<void> {
  if (context && (!context.accountId || context.accountId.includes("\0")))
    throw new Error("Invalid transaction account");
  if (
    context?.tenantId !== null &&
    context?.tenantId !== undefined &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      context.tenantId,
    )
  )
    throw new Error("Invalid transaction municipality");
  await client.query(
    "SELECT set_config('quenda.account_id', $1, true), set_config('quenda.tenant_id', $2, true)",
    [context?.accountId ?? "", context?.tenantId ?? ""],
  );
  if (context) {
    const active = await client.query<{ active: boolean }>(
      "SELECT domain.lock_active_account() AS active",
    );
    if (!active.rows[0]?.active) throw new HttpError("ACCOUNT_INACTIVE");
  }
}
