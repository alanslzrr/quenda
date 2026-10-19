import type { Pool } from "pg";
import { command } from "../../database/command.ts";
import { HttpError } from "../../http/errors.ts";
import type { AuthenticatedAccount } from "../identity/index.ts";

export async function listOwnNotices(
  pool: Pool,
  actor: AuthenticatedAccount,
  after: string | null = null,
) {
  const cursor = after === null ? [null, null] : after.split(":");
  if (
    after !== null &&
    (cursor.length !== 2 ||
      cursor.some(
        (value) =>
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            value ?? "",
          ),
      ))
  )
    throw new HttpError("INVALID_INPUT");
  return command(
    pool,
    { accountId: actor.accountId, tenantId: null },
    async (client) => {
      const result = await client.query<{
        event_id: string;
        tenant_id: string;
        reservation_id: string;
        revision: number;
        kind: "CONFIRMADA" | "MODIFICADA" | "CANCELADA";
        occurred_at: Date;
        unit_id: string;
        starts_at: Date;
        ends_at: Date;
        timezone: string;
      }>("SELECT * FROM domain.own_reservation_notices($1,$2)", cursor);
      const page = result.rows.slice(0, 20);
      return {
        items: page.map((row) => ({
          eventId: row.event_id,
          tenantId: row.tenant_id,
          reservationId: row.reservation_id,
          revision: row.revision,
          kind: row.kind,
          occurredAt: row.occurred_at.toISOString(),
          unitId: row.unit_id,
          startsAt: row.starts_at.toISOString(),
          endsAt: row.ends_at.toISOString(),
          timeZone: row.timezone,
          reservationPath: `/api/municipalities/${row.tenant_id}/reservations/${row.reservation_id}`,
        })),
        nextCursor:
          result.rows.length > 20
            ? `${page.at(-1)?.event_id}:${page.at(-1)?.tenant_id}`
            : null,
      };
    },
  );
}
