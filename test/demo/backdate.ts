import type { Pool } from "pg";

/** When a seeded reservation was booked and, if it was, cancelled. */
export interface BookingHistory {
  id: string;
  bookedAt: Date;
  cancelledAt?: Date | null;
}

const history =
  "unnest($1::uuid[], $2::timestamptz[], $3::timestamptz[]) AS h(id, booked, cancelled)";

// The database stamps creation, acceptance, events, notices and mail with the
// seeding time. Move them to when the booking and its cancellation happened.
// Every event snapshot carries the acceptance evidence, so the reservation and
// its events change in one transaction, before the deferred snapshot check.
export async function backdateBookings(
  migration: Pool,
  entries: BookingHistory[],
) {
  if (!entries.length) return;
  const values = [
    entries.map((entry) => entry.id),
    entries.map((entry) => entry.bookedAt),
    entries.map((entry) => entry.cancelledAt ?? null),
  ];
  const client = await migration.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE domain.reservation r SET created_at=h.booked,
          rules_accepted_at=CASE WHEN r.rules_accepted_at IS NOT NULL THEN h.booked END,
          conditions_accepted_at=CASE WHEN r.conditions_accepted_at IS NOT NULL THEN h.booked END
         FROM ${history} WHERE r.id=h.id`,
      values,
    );
    // The snapshot function renders the timestamps exactly as events store them.
    await client.query(
      `WITH evidence AS (
         SELECT r.tenant_id, r.id, h.booked, h.cancelled, jsonb_build_object(
           'rulesAcceptedAt', domain.reservation_snapshot(r)->'rulesAcceptedAt',
           'conditionsAcceptedAt', domain.reservation_snapshot(r)->'conditionsAcceptedAt') AS accepted
           FROM domain.reservation r JOIN ${history} ON h.id=r.id)
       UPDATE domain.reservation_event e SET
          occurred_at=CASE WHEN e.revision=1 THEN v.booked
            ELSE coalesce(v.cancelled, e.occurred_at) END,
          after_state=CASE WHEN e.after_state ? 'rulesAcceptedAt'
            THEN e.after_state || v.accepted ELSE e.after_state END,
          before_state=CASE WHEN e.before_state ? 'rulesAcceptedAt'
            THEN e.before_state || v.accepted ELSE e.before_state END
         FROM evidence v
        WHERE e.tenant_id=v.tenant_id AND e.reservation_id=v.id`,
      values,
    );
    await client.query(
      `UPDATE domain.occupancy o SET released_at=h.cancelled FROM ${history}
        WHERE o.reservation_id=h.id AND o.released_at IS NOT NULL AND h.cancelled IS NOT NULL`,
      values,
    );
    // Notices and mail follow their events; older notices have been read.
    await client.query(
      `UPDATE domain.reservation_notice n SET created_at=e.occurred_at,
          read_at=CASE WHEN e.occurred_at < now() - interval '3 days'
            THEN e.occurred_at + interval '2 hours' END
         FROM domain.reservation_event e JOIN ${history} ON h.id=e.reservation_id
        WHERE n.tenant_id=e.tenant_id AND n.event_id=e.id`,
      values,
    );
    await client.query(
      `UPDATE domain.reservation_email m SET created_at=e.occurred_at
         FROM domain.reservation_event e JOIN ${history} ON h.id=e.reservation_id
        WHERE m.tenant_id=e.tenant_id AND m.event_id=e.id`,
      values,
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
