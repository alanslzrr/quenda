import type { Pool } from "pg";
import { command } from "../../database/command.ts";
import { HttpError } from "../../http/errors.ts";
import { type Clock, systemClock } from "../../shared/clock.ts";
import { candidateAvailability } from "../catalog/index.ts";
import {
  type AuthenticatedAccount,
  requirePermission,
} from "../identity/index.ts";
import type { Reservation } from "./state.ts";

export async function ownModificationAvailability(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  reservationId: string,
  unitId: string,
  date: string,
  durationMinutes: number,
  clock: Clock = systemClock,
  administrative = false,
) {
  return command(
    pool,
    { tenantId, accountId: actor.accountId },
    async (client) => {
      const row = (
        await client.query<Reservation>(
          "SELECT * FROM domain.reservation WHERE tenant_id=$1 AND id=$2 AND ($3::boolean OR account_id=$4)",
          [tenantId, reservationId, administrative, actor.accountId],
        )
      ).rows[0];
      if (!row) throw new HttpError("NOT_FOUND");
      if (administrative) {
        await requirePermission(
          client,
          actor,
          "RESERVATION_MANAGE",
          row.unit_id,
        );
        await requirePermission(client, actor, "RESERVATION_MANAGE", unitId);
      }
      if (row.status !== "CONFIRMADA")
        throw new HttpError("RESERVATION_CANCELLED");
      const now = clock.now().getTime();
      if (
        now >= row.starts_at.getTime() ||
        (!administrative &&
          now > row.starts_at.getTime() - row.cancellation_minutes * 60000)
      )
        throw new HttpError("RESERVATION_DEADLINE_PASSED");
      const candidate = await candidateAvailability(
        client,
        tenantId,
        unitId,
        date,
        durationMinutes,
        clock,
      );
      const available = await client.query<{ slot_index: number }>(
        administrative
          ? "SELECT slot_index FROM domain.administrative_reservation_available_slots($1,$2,$3,$4::timestamptz[],$5::timestamptz[])"
          : "SELECT slot_index FROM domain.own_reservation_available_slots($1,$2,$3,$4::timestamptz[],$5::timestamptz[])",
        [
          tenantId,
          unitId,
          reservationId,
          candidate.slots.map((slot) => slot.start.utc),
          candidate.slots.map((slot) => slot.end.utc),
        ],
      );
      const positions = new Set(available.rows.map((row) => row.slot_index));
      return {
        ...candidate,
        slots: candidate.slots.filter((_, index) => positions.has(index + 1)),
      };
    },
  );
}
