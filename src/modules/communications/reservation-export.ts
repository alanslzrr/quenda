import { Temporal } from "@js-temporal/polyfill";
import { DatabaseError, type Pool } from "pg";
import { command } from "../../database/command.ts";
import { HttpError } from "../../http/errors.ts";
import { civilDate } from "../../shared/civil-date.ts";
import {
  type AuthenticatedAccount,
  requirePermission,
} from "../identity/index.ts";

export async function exportReservations(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  from: string,
  to: string,
  unitId: string | null = null,
) {
  try {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(from) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(to) ||
      (unitId !== null &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          unitId,
        ))
    )
      throw new HttpError("INVALID_INPUT");
    const days = Temporal.PlainDate.from(civilDate(from)).until(
      Temporal.PlainDate.from(civilDate(to)),
    ).days;
    if (days < 1 || days > 366) throw new HttpError("INVALID_INPUT");
    return await command(
      pool,
      { accountId: actor.accountId, tenantId },
      async (client) => {
        await requirePermission(client, actor, "DATA_EXPORT", unitId);
        const row = (
          await client.query<{ document: unknown }>(
            "SELECT domain.reservation_export($1,$2,$3) AS document",
            [from, to, unitId],
          )
        ).rows[0];
        if (!row) throw new Error("Missing export projection");
        return row.document;
      },
    );
  } catch (error) {
    if (error instanceof RangeError) throw new HttpError("INVALID_INPUT");
    if (error instanceof DatabaseError) {
      if (error.code === "23514") throw new HttpError("INVALID_INPUT");
      if (error.code === "42501") throw new HttpError("FORBIDDEN");
      if (error.code === "P0002") throw new HttpError("NOT_FOUND");
    }
    throw error;
  }
}
