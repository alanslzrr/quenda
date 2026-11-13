import { Temporal } from "@js-temporal/polyfill";
import { DatabaseError, type Pool } from "pg";
import { command } from "../../database/command.ts";
import { HttpError } from "../../http/errors.ts";
import { civilDate } from "../../shared/civil-date.ts";
import {
  type AuthenticatedAccount,
  requireMfaSession,
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
import {
  type AnalyticsReservation,
  type AnalyticsUnitInfo,
  type Granularity,
  usageAnalytics,
} from "./usage-analytics.ts";

type Source = IndicatorHistory & {
  timeZone: string;
  asOf: string;
  closures: MetricInterval[];
  reservations: MetricReservation[];
};
export function readUnitIndicators(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  unitId: string,
  from: string,
  to: string,
) {
  return readIndicators(pool, actor, tenantId, unitId, from, to);
}
export function readMunicipalIndicators(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  from: string,
  to: string,
) {
  return readIndicators(pool, actor, tenantId, null, from, to);
}
export function readUsageAnalytics(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  unitId: string | null,
  from: string,
  to: string,
  granularity?: Granularity,
) {
  return readIndicators(pool, actor, tenantId, unitId, from, to, {
    granularity,
  });
}
/**
 * Spaces the account may analyse, grouped by facility, including withdrawn
 * ones. Up to 500; `truncated` tells the client that more exist.
 */
export async function readReportUnits(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
) {
  requireMfaSession(actor);
  const rows = await command(
    pool,
    { accountId: actor.accountId, tenantId },
    async (client) =>
      (
        await client.query<{
          unitId: string;
          name: string;
          facilityId: string;
          facilityName: string;
          withdrawn: boolean;
        }>(
          'SELECT id AS "unitId",name,facility_id AS "facilityId",facility_name AS "facilityName",withdrawn FROM domain.report_units()',
        )
      ).rows,
  );
  return { units: rows.slice(0, 500), truncated: rows.length > 500 };
}
async function readIndicators(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  unitId: string | null,
  from: string,
  to: string,
  analytics?: { granularity?: Granularity | undefined },
) {
  try {
    if (
      (unitId !== null &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          unitId,
        )) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(from) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(to)
    )
      throw new HttpError("INVALID_INPUT");
    const first = Temporal.PlainDate.from(civilDate(from)),
      last = Temporal.PlainDate.from(civilDate(to));
    if (first.until(last).days < 1 || first.until(last).days > 366)
      throw new HttpError("INVALID_INPUT");
    unitId = unitId?.toLowerCase() ?? null;
    return await command(
      pool,
      { accountId: actor.accountId, tenantId },
      async (client) => {
        await requirePermission(client, actor, "REPORT_READ", unitId);
        const projection =
          unitId === null
            ? (
                await client.query<{
                  source: {
                    timeZone: string;
                    asOf: string;
                    units: Array<{ unitId: string; source: Source }>;
                  };
                }>(
                  "SELECT domain.municipal_indicator_source($1,$2) AS source",
                  [from, to],
                )
              ).rows[0]?.source
            : await (async () => {
                const source = (
                  await client.query<{ source: Source }>(
                    "SELECT domain.unit_indicator_source($1,$2,$3) AS source",
                    [unitId, from, to],
                  )
                ).rows[0]?.source;
                return (
                  source && {
                    timeZone: source.timeZone,
                    asOf: source.asOf,
                    units: [{ unitId, source }],
                  }
                );
              })();
        if (!projection) throw new Error("Missing indicator projection");
        const { timeZone, asOf } = projection;
        const start = first.toZonedDateTime(timeZone).toInstant().toString();
        const end = last.toZonedDateTime(timeZone).toInstant().toString();
        const units = projection.units.map(({ unitId, source }) => ({
          id: unitId,
          calendars: publishedCalendarSlices(source, start, end),
          closures: source.closures,
        }));
        if (analytics) {
          const facts = (
            await client.query<{
              source: {
                reservations: AnalyticsReservation[];
                units: Record<string, AnalyticsUnitInfo>;
              };
            }>("SELECT domain.usage_analytics_source($1,$2,$3) AS source", [
              unitId,
              from,
              to,
            ])
          ).rows[0]?.source;
          if (!facts) throw new Error("Missing analytics projection");
          return {
            tenantId,
            unitId,
            ...usageAnalytics({
              from,
              to,
              timeZone,
              asOf,
              units,
              reservations: facts.reservations,
              unitInfo: facts.units,
              granularity: analytics.granularity,
            }),
          };
        }

        return {
          tenantId,
          ...(unitId === null ? {} : { unitId }),
          ...municipalIndicators({
            from,
            to,
            timeZone,
            asOf,
            units,
            reservations: projection.units.flatMap(
              ({ source }) => source.reservations,
            ),
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
