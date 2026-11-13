import type { Pool } from "pg";
import { command } from "../../database/command.ts";
import { HttpError } from "../../http/errors.ts";
import type { AuthenticatedAccount } from "../identity/index.ts";

const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** Creation instant to the microsecond, municipality and event: the position after the last notice of a page. */
const cursorPattern = new RegExp(
  `^(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{6}Z)~(${uuid})~(${uuid})$`,
  "i",
);
export const noticeCursorMaxLength = 101;

export async function listOwnNotices(
  pool: Pool,
  actor: AuthenticatedAccount,
  after: string | null = null,
) {
  const match = after === null ? null : cursorPattern.exec(after);
  if (after !== null && !match) throw new HttpError("INVALID_INPUT");
  const cursor = match ? [match[1], match[2], match[3]] : [null, null, null];
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
        administrative: boolean;
        actor_name: string | null;
        reason: string | null;
        unit_id: string;
        starts_at: Date;
        ends_at: Date;
        timezone: string;
        pending_usage_rules_version: number | null;
        municipality: string;
        unit_name: string | null;
        facility_name: string | null;
        read_at: Date | null;
        position: string;
      }>(
        `SELECT n.*,to_char(n.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS position
         FROM domain.own_reservation_notices($1::timestamptz,$2::uuid,$3::uuid) n`,
        cursor,
      );
      const page = result.rows.slice(0, 20);
      const last = page.at(-1);
      return {
        items: page.map((row) => ({
          eventId: row.event_id,
          tenantId: row.tenant_id,
          reservationId: row.reservation_id,
          revision: row.revision,
          kind: row.kind,
          administrative: row.administrative,
          actorName: row.actor_name,
          reason: row.reason,
          occurredAt: row.occurred_at.toISOString(),
          unitId: row.unit_id,
          municipality: row.municipality,
          unitName: row.unit_name,
          facilityName: row.facility_name,
          startsAt: row.starts_at.toISOString(),
          endsAt: row.ends_at.toISOString(),
          timeZone: row.timezone,
          pendingUsageRulesVersion: row.pending_usage_rules_version,
          readAt: row.read_at?.toISOString() ?? null,
          reservationPath: `/api/municipalities/${row.tenant_id}/reservations/${row.reservation_id}`,
        })),
        nextCursor:
          result.rows.length > 20 && last
            ? `${last.position}~${last.tenant_id}~${last.event_id}`
            : null,
      };
    },
  );
}

/** How many of the caller's notices have not been read yet. */
export async function countUnreadNotices(
  pool: Pool,
  actor: AuthenticatedAccount,
) {
  return command(
    pool,
    { accountId: actor.accountId, tenantId: null },
    async (client) => {
      const result = await client.query<{ unread: number }>(
        "SELECT domain.own_unread_notice_count() AS unread",
      );
      return { unread: result.rows[0]?.unread ?? 0 };
    },
  );
}

/** Marks one notice of the caller as read, or every unread one when `target` is omitted. Reading twice changes nothing. */
export async function readOwnNotices(
  pool: Pool,
  actor: AuthenticatedAccount,
  target?: { tenantId: string; eventId: string },
) {
  return command(
    pool,
    { accountId: actor.accountId, tenantId: null },
    async (client) => {
      const result = await client.query<{ read: number }>(
        "SELECT domain.read_own_notices($1::uuid,$2::uuid) AS read",
        [target?.tenantId ?? null, target?.eventId ?? null],
      );
      return { read: result.rows[0]?.read ?? 0 };
    },
  );
}
