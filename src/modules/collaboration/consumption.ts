import { DatabaseError, type PoolClient } from "pg";
import { HttpError } from "../../http/errors.ts";

// Runs on the booking command's existing transaction; never opens a second one.
export async function syncReservationConsumption(
  client: PoolClient,
  reservationId: string,
  correlationId: string,
) {
  try {
    await client.query("SELECT domain.sync_reservation_consumption($1,$2)", [
      reservationId,
      correlationId,
    ]);
  } catch (error) {
    if (error instanceof DatabaseError) {
      if (error.code === "23514") throw new HttpError("CONFLICT");
      if (error.code === "P0002") throw new HttpError("NOT_FOUND");
      if (error.code === "42501") throw new HttpError("FORBIDDEN");
    }
    throw error;
  }
}

// Existing reservations must take agreement locks before their row lock, just
// like activation/reconciliation. Keep this on the caller's transaction client.
export async function lockBookingAgreements(
  client: PoolClient,
  reservationId: string,
  destinationUnitId: string | null = null,
) {
  try {
    await client.query("SELECT domain.lock_booking_agreements($1,$2)", [
      reservationId,
      destinationUnitId,
    ]);
  } catch (error) {
    if (error instanceof DatabaseError) {
      if (error.code === "42501") throw new HttpError("FORBIDDEN");
      if (error.code === "P0002") throw new HttpError("NOT_FOUND");
    }
    throw error;
  }
}
