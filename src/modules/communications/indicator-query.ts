import { Temporal } from "@js-temporal/polyfill";
import { DatabaseError, type Pool } from "pg";
import { command } from "../../database/command.ts";
import { HttpError } from "../../http/errors.ts";
import {
  type AuthenticatedAccount,
  requirePermission,
} from "../identity/index.ts";
import {
  type IndicatorHistory,
  publishedCalendarSlices,
} from "./indicator-history.ts";
import {
  type MetricInterval,
  type MetricReservation,
  municipalIndicators,
} from "./indicators.ts";
export async function readUnitIndicators(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  unitId: string,
  from: string,
  to: string,
) {
  try {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        unitId,
      ) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(from) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(to)
    )
      throw new HttpError("INVALID_INPUT");
    const first = Temporal.PlainDate.from(from),
      last = Temporal.PlainDate.from(to);
    if (first.until(last).days < 1 || first.until(last).days > 366)
      throw new HttpError("INVALID_INPUT");
    unitId = unitId.toLowerCase();
    return await command(
      pool,
      { accountId: actor.accountId, tenantId },
      async (client) => {
        await requirePermission(client, actor, "REPORT_READ", unitId);
        const row = (
          await client.query<{
            source: IndicatorHistory & {
              timeZone: string;
              asOf: string;
              closures: MetricInterval[];
              reservations: MetricReservation[];
            };
          }>("SELECT domain.unit_indicator_source($1,$2,$3) AS source", [
            unitId,
            from,
            to,
          ])
        ).rows[0];
        if (!row) throw new Error("Missing indicator projection");
        const source = row.source;
        const calendars = publishedCalendarSlices(
          source,
          first.toZonedDateTime(source.timeZone).toInstant().toString(),
          last.toZonedDateTime(source.timeZone).toInstant().toString(),
        );
        return {
          tenantId,
          unitId,
          ...municipalIndicators({
            from,
            to,
            timeZone: source.timeZone,
            asOf: source.asOf,
            units: [{ id: unitId, calendars, closures: source.closures }],
            reservations: source.reservations,
          }),
        };
      },
    );
  } catch (error) {
    if (error instanceof RangeError) throw new HttpError("INVALID_INPUT");
    if (error instanceof DatabaseError) {
      if (error.code === "23514") throw new HttpError("INVALID_INPUT");
      if (error.code === "42501") throw new HttpError("FORBIDDEN");
      if (error.code === "P0002") throw new HttpError("NOT_FOUND");
    }
    throw error;
  }
}
