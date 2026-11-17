import { DatabaseError, type Pool } from "pg";
import { command } from "../../database/command.ts";
import { HttpError } from "../../http/errors.ts";
import {
  type AuthenticatedAccount,
  requireMfaSession,
} from "../identity/index.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Records that the holder arrived, after staff checked the reservation's access
 * code. Allowed from 30 minutes before the start until the end; a second call
 * returns the first record unchanged.
 */
export async function recordReservationArrival(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  reservationId: string,
) {
  if (!uuid.test(tenantId) || !uuid.test(reservationId))
    throw new HttpError("INVALID_INPUT");
  requireMfaSession(actor);
  try {
    const row = await command(
      pool,
      { accountId: actor.accountId, tenantId },
      async (client) =>
        (
          await client.query<{
            arrived_at: Date;
            already_recorded: boolean;
          }>(
            "SELECT arrived_at,already_recorded FROM domain.record_reservation_arrival($1,$2)",
            [tenantId, reservationId],
          )
        ).rows[0],
    );
    if (!row) throw new Error("Missing arrival record");
    return {
      arrivedAt: row.arrived_at.toISOString(),
      alreadyRecorded: row.already_recorded,
    };
  } catch (error) {
    if (error instanceof DatabaseError) {
      if (error.code === "P0002") throw new HttpError("NOT_FOUND");
      if (error.code === "23514") throw new HttpError("ARRIVAL_OUTSIDE_WINDOW");
      if (error.code === "42501") throw new HttpError("FORBIDDEN");
    }
    throw error;
  }
}
