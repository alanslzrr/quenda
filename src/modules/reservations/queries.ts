import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { command } from "../../database/command.ts";
import { HttpError } from "../../http/errors.ts";
import { type Clock, systemClock } from "../../shared/clock.ts";
import type { AuthenticatedAccount } from "../identity/index.ts";
import { present, type Reservation } from "./state.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function ownCursor(after: string | null) {
  if (after === null) return [null, null];
  const parts = after.split(":");
  if (parts.length !== 2 || parts.some((part) => !uuid.test(part)))
    throw new HttpError("INVALID_INPUT");
  return parts;
}
function current(row: Omit<Reservation, "account_id">, now: number) {
  return {
    ...present(row),
    status:
      row.status === "CONFIRMADA" && row.ends_at.getTime() <= now
        ? "FINALIZADA"
        : row.status,
  };
}
export async function listOwnReservations(
  pool: Pool,
  actor: AuthenticatedAccount,
  options: { after?: string | null; tenantId?: string | null } = {},
  clock: Clock = systemClock,
) {
  const cursor = ownCursor(options.after ?? null);
  const tenantId = options.tenantId ?? null;
  if (tenantId !== null && !uuid.test(tenantId))
    throw new HttpError("INVALID_INPUT");
  return command(
    pool,
    { accountId: actor.accountId, tenantId: null },
    async (client) => {
      const result = await client.query<
        Omit<Reservation, "account_id"> & {
          municipality: string;
          unit_name: string;
        }
      >("SELECT * FROM domain.own_reservations($1,$2,$3)", [
        ...cursor,
        tenantId,
      ]);
      const page = result.rows.slice(0, 20),
        now = clock.now().getTime();
      return {
        items: page.map((row) => ({
          ...current(row, now),
          municipality: row.municipality,
          unitName: row.unit_name,
        })),
        nextCursor:
          result.rows.length > 20
            ? `${page.at(-1)?.id}:${page.at(-1)?.tenant_id}`
            : null,
      };
    },
  );
}
export async function listMunicipalReservations(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  options: {
    after?: string | null;
    unitId?: string | null;
    date?: string;
  } = {},
  clock: Clock = systemClock,
  correlationId: string = randomUUID(),
) {
  const after = options.after ?? null,
    unitId = options.unitId ?? null;
  if (
    (after !== null && !uuid.test(after)) ||
    (unitId !== null && !uuid.test(unitId))
  )
    throw new HttpError("INVALID_INPUT");
  if (!actor.mfaVerifiedAt) throw new HttpError("FORBIDDEN");
  return command(
    pool,
    { accountId: actor.accountId, tenantId },
    async (client) => {
      const result = await client.query<Reservation>(
        `SELECT r.* FROM domain.reservation r WHERE r.tenant_id=$1
   AND ($2::uuid IS NULL OR r.id>$2) AND ($3::uuid IS NULL OR r.unit_id=$3)
   AND ($4::date IS NULL OR (r.starts_at < (($4::date+1)::timestamp AT TIME ZONE (SELECT timezone FROM domain.municipality WHERE id=$1)) AND r.ends_at > ($4::date::timestamp AT TIME ZONE (SELECT timezone FROM domain.municipality WHERE id=$1))))
   AND (domain.lock_permission('RESERVATION_READ',r.unit_id) OR domain.lock_permission('RESERVATION_MANAGE',r.unit_id))
   ORDER BY r.id LIMIT 21`,
        [tenantId, after, unitId, options.date ?? null],
      );
      const page = result.rows.slice(0, 20),
        now = clock.now().getTime();
      if (page.length)
        await client.query(
          "SELECT domain.record_reservation_reads($1::uuid[],'MUNICIPAL_LIST',$2)",
          [page.map((row) => row.id), correlationId],
        );
      return {
        items: page.map((row) => ({
          ...current(row, now),
          accountId: row.account_id,
        })),
        nextCursor: result.rows.length > 20 ? (page.at(-1)?.id ?? null) : null,
      };
    },
  );
}

export async function readReservation(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  reservationId: string,
  clock: Clock = systemClock,
  correlationId: string = randomUUID(),
) {
  if (!uuid.test(reservationId)) throw new HttpError("INVALID_INPUT");
  return command(
    pool,
    { accountId: actor.accountId, tenantId },
    async (client) => {
      const found = await client.query<Reservation>(
        "SELECT * FROM domain.reservation WHERE tenant_id=$1 AND id=$2",
        [tenantId, reservationId],
      );
      const row = found.rows[0];
      if (!row) throw new HttpError("NOT_FOUND");
      // RLS has already checked current per-unit READ/MANAGE authority for anyone
      // other than the owner. Staff access also requires a verified MFA session.
      if (row.account_id !== actor.accountId && !actor.mfaVerifiedAt)
        throw new HttpError("FORBIDDEN");
      if (row.account_id !== actor.accountId)
        await client.query(
          "SELECT domain.record_reservation_reads($1::uuid[],'DETAIL',$2)",
          [[row.id], correlationId],
        );
      return {
        ...current(row, clock.now().getTime()),
        accountId: row.account_id,
        pendingUsageRulesText:
          (
            await client.query<{ text: string | null }>(
              "SELECT domain.pending_usage_rules($1) AS text",
              [reservationId],
            )
          ).rows[0]?.text ?? null,
        usageRulesText:
          (
            await client.query<{ text: string | null }>(
              "SELECT domain.accepted_usage_rules($1) AS text",
              [reservationId],
            )
          ).rows[0]?.text ?? null,
      };
    },
  );
}
