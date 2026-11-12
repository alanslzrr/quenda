import type { Pool } from "pg";
import { command } from "../../database/command.ts";
import { HttpError } from "../../http/errors.ts";
import { type Clock, systemClock } from "../../shared/clock.ts";
import { type CalendarSlot, nextHabitualSlot } from "../catalog/index.ts";
import {
  type AuthenticatedAccount,
  recommendationsEnabled,
} from "../identity/index.ts";

/** How far back a habit is read: about six months of the holder's bookings. */
export const recommendationHistoryDays = 183;
const shown = 3;

/**
 * Free slots that repeat the holder's own habits: the same unit, weekday, local
 * start and duration booked at least twice in the last six months. Computed on
 * each request from the account's confirmed reservations and never stored.
 * Units that are no longer public, or that no longer admit the habit, are left
 * out instead of failing the whole answer.
 */
export async function ownRecommendations(
  pool: Pool,
  actor: AuthenticatedAccount,
  clock: Clock = systemClock,
) {
  return command(
    pool,
    { accountId: actor.accountId, tenantId: null },
    async (client) => {
      if (!(await recommendationsEnabled(client, actor.accountId)))
        return { enabled: false, items: [] };
      const since = new Date(
        clock.now().getTime() - recommendationHistoryDays * 86_400_000,
      );
      const habits = await client.query<{
        tenant_id: string;
        unit_id: string;
        municipality: string;
        weekday: number;
        start_minute: number;
        duration_minutes: number;
        occurrences: number;
      }>("SELECT * FROM domain.own_booking_habits($1)", [since]);
      const items: {
        tenantId: string;
        municipality: string;
        unitId: string;
        unitName: string;
        facilityName: string;
        weekday: number;
        startMinute: number;
        durationMinutes: number;
        occurrences: number;
        slot: CalendarSlot;
      }[] = [];
      for (const habit of habits.rows) {
        if (items.length === shown) break;
        let next: Awaited<ReturnType<typeof nextHabitualSlot>>;
        try {
          next = await nextHabitualSlot(
            client,
            habit.tenant_id,
            habit.unit_id,
            {
              weekday: habit.weekday,
              startMinute: habit.start_minute,
              durationMinutes: habit.duration_minutes,
            },
            clock,
          );
        } catch (error) {
          // Unpublished since, or the calendar no longer admits this duration.
          if (error instanceof HttpError) continue;
          throw error;
        }
        if (
          !next ||
          items.some(
            (item) =>
              item.unitId === habit.unit_id &&
              item.slot.start.utc === next?.slot.start.utc,
          )
        )
          continue;
        items.push({
          tenantId: habit.tenant_id,
          municipality: habit.municipality,
          unitId: habit.unit_id,
          unitName: next.unitName,
          facilityName: next.facilityName,
          weekday: habit.weekday,
          startMinute: habit.start_minute,
          durationMinutes: habit.duration_minutes,
          occurrences: habit.occurrences,
          slot: next.slot,
        });
      }
      return { enabled: true, items };
    },
  );
}
