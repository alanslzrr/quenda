import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

// Use the command's transaction client after changing the reservation and its
// occupancy. PostgreSQL captures the snapshot and queues both notices atomically.
export async function appendReservationEvent(
  client: PoolClient,
  reservationId: string,
  correlationId: string,
  reason: string | null = null,
  administrative = false,
  acceptanceOnly = false,
): Promise<string> {
  const eventId = randomUUID();
  await client.query(
    "SELECT domain.append_reservation_event($1,$2,$3,$4,$5,$6)",
    [
      reservationId,
      eventId,
      correlationId,
      reason,
      administrative,
      acceptanceOnly,
    ],
  );
  return eventId;
}
