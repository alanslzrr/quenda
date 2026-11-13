import { DatabaseError, type Pool } from "pg";
import { command } from "../../database/command.ts";
import { HttpError } from "../../http/errors.ts";
import {
  type AuthenticatedAccount,
  requireAdministrator,
  requireMfaSession,
} from "../identity/index.ts";

export const analyticsPeriods = [
  "THIS_WEEK",
  "THIS_MONTH",
  "LAST_MONTH",
  "LAST_30_DAYS",
] as const;
export type AnalyticsPeriod = (typeof analyticsPeriods)[number];
/**
 * Municipal analytics settings. Occupancy at or above `highDemandPercent`
 * labels a space as in high demand; below `lowUsePercent`, as little used.
 */
export interface AnalyticsSettings {
  version: number;
  highDemandPercent: number;
  lowUsePercent: number;
  defaultPeriod: AnalyticsPeriod;
}
export type AnalyticsSettingsInput = Omit<AnalyticsSettings, "version"> & {
  expectedVersion: number;
};

type Row = {
  version: number;
  high_demand_percent: number;
  low_use_percent: number;
  default_period: AnalyticsPeriod;
};
const settings = (row: Row): AnalyticsSettings => ({
  version: row.version,
  highDemandPercent: row.high_demand_percent,
  lowUsePercent: row.low_use_percent,
  defaultPeriod: row.default_period,
});
const forbidden = (error: unknown) => {
  if (error instanceof DatabaseError && error.code === "42501")
    throw new HttpError("FORBIDDEN");
  throw error;
};

/** Readable with REPORT_READ over the municipality or any of its units. */
export async function readAnalyticsSettings(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
): Promise<AnalyticsSettings> {
  requireMfaSession(actor);
  return command(
    pool,
    { accountId: actor.accountId, tenantId },
    async (client) => {
      const row = (
        await client
          .query<Row>("SELECT * FROM domain.municipal_analytics_settings()")
          .catch(forbidden)
      ).rows[0];
      if (!row) throw new HttpError("NOT_FOUND");
      return settings(row);
    },
  );
}

/** Only the municipal administrator, with recent MFA; versioned and audited. */
export async function saveAnalyticsSettings(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  input: AnalyticsSettingsInput,
  correlationId: string,
): Promise<AnalyticsSettings> {
  const percent = (value: number) =>
    Number.isInteger(value) && value >= 1 && value <= 99;
  if (
    !Number.isInteger(input.expectedVersion) ||
    input.expectedVersion < 1 ||
    input.expectedVersion >= 2147483647 ||
    !percent(input.highDemandPercent) ||
    !percent(input.lowUsePercent) ||
    input.lowUsePercent >= input.highDemandPercent ||
    !analyticsPeriods.includes(input.defaultPeriod)
  )
    throw new HttpError("INVALID_INPUT");
  return command(
    pool,
    { accountId: actor.accountId, tenantId },
    async (client) => {
      await requireAdministrator(client, actor);
      const row = (
        await client.query<{ version: number | null }>(
          "SELECT domain.save_municipal_analytics_settings($1,$2,$3,$4,$5) AS version",
          [
            input.expectedVersion,
            input.highDemandPercent,
            input.lowUsePercent,
            input.defaultPeriod,
            correlationId,
          ],
        )
      ).rows[0];
      if (!row?.version) throw new HttpError("CONFLICT");
      return {
        version: row.version,
        highDemandPercent: input.highDemandPercent,
        lowUsePercent: input.lowUsePercent,
        defaultPeriod: input.defaultPeriod,
      };
    },
  );
}
