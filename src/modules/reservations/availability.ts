import type { Pool } from "pg";
import { command } from "../../database/command.ts";
import { HttpError } from "../../http/errors.ts";
import { type Clock, systemClock } from "../../shared/clock.ts";
import { candidateAvailability } from "../catalog/index.ts";
import type { AuthenticatedAccount } from "../identity/index.ts";
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
) {
  return command(
    pool,
    { tenantId, accountId: actor.accountId },
    async (client) => {
      const row = (
        await client.query<Reservation>(
          "SELECT * FROM domain.reservation WHERE tenant_id=$1 AND id=$2 AND account_id=$3",
          [tenantId, reservationId, actor.accountId],
        )
      ).rows[0];
      if (!row) throw new HttpError("NOT_FOUND");
      if (row.status !== "CONFIRMADA") throw new HttpError("CONFLICT");
      const now = clock.now().getTime();
      if (
        now >= row.starts_at.getTime() ||
        now > row.starts_at.getTime() - row.cancellation_minutes * 60000
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
        "SELECT slot_index FROM domain.own_reservation_available_slots($1,$2,$3,$4::timestamptz[],$5::timestamptz[])",
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
