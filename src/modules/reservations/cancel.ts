import { DatabaseError, type Pool } from "pg";
import { idempotentCommand } from "../../database/idempotency.ts";
import { HttpError } from "../../http/errors.ts";
import { type Clock, systemClock } from "../../shared/clock.ts";
import {
  type AuthenticatedAccount,
  requirePermission,
} from "../identity/index.ts";
import { appendReservationEvent } from "./events.ts";

export interface CancelReservationInput {
  expectedRevision: number;
  administrative?: boolean;
  reason?: string;
}
interface Reservation {
  id: string;
  tenant_id: string;
  account_id: string;
  unit_id: string;
  starts_at: Date;
  ends_at: Date;
  status: "CONFIRMADA" | "CANCELADA";
  revision: number;
  calendar_version: number;
  cancellation_minutes: number;
  timezone: string;
}
const present = (row: Reservation) => ({
  id: row.id,
  tenantId: row.tenant_id,
  unitId: row.unit_id,
  startsAt: row.starts_at.toISOString(),
  endsAt: row.ends_at.toISOString(),
  status: row.status,
  revision: row.revision,
  calendarVersion: row.calendar_version,
  cancellationMinutes: row.cancellation_minutes,
  timeZone: row.timezone,
});
export async function cancelReservation(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  reservationId: string,
  key: string,
  input: CancelReservationInput,
  correlationId: string,
  retentionSeconds: number,
  clock: Clock = systemClock,
) {
  const administrative = input.administrative ?? false;
  const reason = input.reason?.trim() ?? null;
  if (
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 1 ||
    (reason !== null && (reason.length < 1 || reason.length > 500)) ||
    (administrative && !reason)
  )
    throw new HttpError("INVALID_INPUT");
  let reservation: Reservation;
  try {
    return await idempotentCommand(
      pool,
      { accountId: actor.accountId, tenantId },
      {
        operation: "reservation.cancel",
        key,
        input: {
          reservationId,
          expectedRevision: input.expectedRevision,
          administrative,
          reason,
        },
        retentionSeconds,
        authorize: async (client) => {
          const found = await client.query<Reservation>(
            "SELECT * FROM domain.reservation WHERE tenant_id=$1 AND id=$2",
            [tenantId, reservationId],
          );
          const row = found.rows[0];
          if (!row) throw new HttpError("NOT_FOUND");
          if (administrative)
            await requirePermission(
              client,
              actor,
              "RESERVATION_MANAGE",
              row.unit_id,
            );
          else if (row.account_id !== actor.accountId)
            throw new HttpError("FORBIDDEN");
          reservation = row;
        },
        execute: async (client) => {
          const locked = await client.query<Reservation>(
            "SELECT * FROM domain.reservation WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
            [tenantId, reservationId],
          );
          if (!locked.rows[0]) throw new HttpError("NOT_FOUND");
          reservation = locked.rows[0];
          if (reservation.status === "CANCELADA") return present(reservation);
          if (reservation.revision !== input.expectedRevision)
            throw new HttpError("CONFLICT");
          const now = clock.now().getTime();
          const deadline =
            reservation.starts_at.getTime() -
            (administrative ? 0 : reservation.cancellation_minutes * 60000);
          if (!Number.isFinite(now) || now >= deadline)
            throw new HttpError("CONFLICT");
          const updated = await client.query<Reservation>(
            "UPDATE domain.reservation SET status='CANCELADA',revision=revision+1 WHERE tenant_id=$1 AND id=$2 RETURNING *",
            [tenantId, reservationId],
          );
          await client.query(
            "UPDATE domain.occupancy SET released_at=clock_timestamp() WHERE tenant_id=$1 AND reservation_id=$2 AND released_at IS NULL",
            [tenantId, reservationId],
          );
          await appendReservationEvent(
            client,
            reservationId,
            correlationId,
            reason,
          );
          return present(updated.rows[0] as Reservation);
        },
      },
    );
  } catch (error) {
    if (
      error instanceof DatabaseError &&
      ["40001", "40P01"].includes(error.code ?? "")
    )
      throw new HttpError("CONFLICT");
    throw error;
  }
}
