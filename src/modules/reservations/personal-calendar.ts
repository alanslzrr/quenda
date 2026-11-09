import type { Pool } from "pg";
import { command } from "../../database/command.ts";
import { HttpError } from "../../http/errors.ts";
import type { AuthenticatedAccount } from "../identity/index.ts";
import { type CalendarEvent, calendarFile } from "./icalendar.ts";

interface Row {
  tenant_id: string;
  id: string;
  status: "CONFIRMADA" | "CANCELADA";
  starts_at: Date;
  ends_at: Date;
  revision: number;
  municipality: string;
  unit_name: string;
  facility_name: string;
  address: string | null;
  postal_code: string | null;
  latitude: string | null;
  longitude: string | null;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const upcomingLimit = 100;

const wording = {
  es: {
    summary: (unit: string, municipality: string) =>
      `Reserva: ${unit} (${municipality})`,
    calendar: "Mis reservas de Quenda",
    one: "Reserva de Quenda",
    facility: "Instalación",
    link: "Consultar o cambiar la reserva",
  },
  gl: {
    summary: (unit: string, municipality: string) =>
      `Reserva: ${unit} (${municipality})`,
    calendar: "As miñas reservas de Quenda",
    one: "Reserva de Quenda",
    facility: "Instalación",
    link: "Consultar ou cambiar a reserva",
  },
} as const;

/** The calendar entry for a reservation: its start, end, place and a link back to the reservation. */
export function toEvent(
  row: Row,
  origin: string,
  locale: "es" | "gl",
): CalendarEvent {
  const text = wording[locale];
  const url = `${origin}/reservas/${row.tenant_id}/${row.id}`;
  const place = [row.facility_name, row.address, row.postal_code]
    .filter(Boolean)
    .join(", ");
  return {
    uid: `${row.id}@${new URL(origin).hostname}`,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    sequence: row.revision,
    status: row.status === "CANCELADA" ? "CANCELLED" : "CONFIRMED",
    summary: text.summary(row.unit_name, row.municipality),
    description: `${text.facility}: ${row.facility_name}\n${text.link}: ${url}`,
    location: place,
    geo:
      row.latitude !== null && row.longitude !== null
        ? { latitude: Number(row.latitude), longitude: Number(row.longitude) }
        : undefined,
    url,
  };
}

/** The account's confirmed reservations that have not ended, soonest first, up to a fixed cap. */
export async function upcomingCalendar(
  pool: Pool,
  actor: AuthenticatedAccount,
  origin: string,
  locale: "es" | "gl",
  now: Date = new Date(),
) {
  const rows = await command(
    pool,
    { accountId: actor.accountId, tenantId: null },
    async (client) =>
      (
        await client.query<Row>(
          "SELECT * FROM domain.own_calendar_reservations($1)",
          [upcomingLimit],
        )
      ).rows,
  );
  return calendarFile(
    rows.map((row) => toEvent(row, origin, locale)),
    { name: wording[locale].calendar, stamp: now },
  );
}

/** One reservation of the account, in any state: a cancelled one is published as cancelled. */
export async function reservationCalendar(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  reservationId: string,
  origin: string,
  locale: "es" | "gl",
  now: Date = new Date(),
) {
  if (!uuid.test(tenantId) || !uuid.test(reservationId))
    throw new HttpError("INVALID_INPUT");
  const row = await command(
    pool,
    { accountId: actor.accountId, tenantId: null },
    async (client) =>
      (
        await client.query<Row>(
          "SELECT * FROM domain.own_calendar_reservation($1,$2)",
          [tenantId, reservationId],
        )
      ).rows[0],
  );
  if (!row) throw new HttpError("NOT_FOUND");
  return calendarFile([toEvent(row, origin, locale)], {
    name: wording[locale].one,
    stamp: now,
  });
}
