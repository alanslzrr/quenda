import type { Pool } from "pg";
import { command } from "../../database/command.ts";
import { HttpError } from "../../http/errors.ts";
import {
  type AuthenticatedAccount,
  requireAdministrator,
} from "../identity/index.ts";

// A municipal catalog is a few dozen resources. The cap only protects against a runaway read.
const limit = 5000;

/**
 * The municipality's whole catalog and configuration as one document, read in a single
 * transaction so it is internally consistent. It holds no reservations and no personal data.
 */
export async function exportCatalog(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
) {
  return command(
    pool,
    { accountId: actor.accountId, tenantId },
    async (client) => {
      await requireAdministrator(client, actor);
      const municipality = (
        await client.query<{
          name: string;
          timezone: string;
          booking_policy_version: number;
          advance_days: number;
          cancellation_minutes: number;
          light_palette: string;
          dark_palette: string;
          default_theme: string;
        }>(
          "SELECT name,timezone,booking_policy_version,advance_days,cancellation_minutes,light_palette,dark_palette,default_theme FROM domain.municipality WHERE id=$1",
          [tenantId],
        )
      ).rows[0];
      if (!municipality) throw new HttpError("NOT_FOUND");
      const facilities = await client.query<{
        id: string;
        name: string;
        published_at: Date | null;
        withdrawn_at: Date | null;
        profile: unknown;
      }>(
        "SELECT f.id,f.name,f.published_at,f.withdrawn_at,domain.facility_profile_json(f) AS profile FROM domain.facility f WHERE f.tenant_id=$1 ORDER BY f.name,f.id LIMIT $2",
        [tenantId, limit + 1],
      );
      const units = await client.query<{
        id: string;
        facility_id: string;
        name: string;
        published_at: Date | null;
        withdrawn_at: Date | null;
        profile: unknown;
        calendar_version: number | null;
        minimum_minutes: number | null;
        maximum_minutes: number | null;
        step_minutes: number | null;
        advance_days: number | null;
        weekly: unknown;
        exceptions: unknown;
        rules_version: number | null;
        rules_text: string | null;
      }>(
        `SELECT u.id,u.facility_id,u.name,u.published_at,u.withdrawn_at,domain.unit_profile_json(u) AS profile,
          c.version AS calendar_version,c.minimum_minutes,c.maximum_minutes,c.step_minutes,c.advance_days,c.weekly,c.exceptions,
          r.version AS rules_version,r.text_content AS rules_text
         FROM domain.reservable_unit u
         LEFT JOIN domain.unit_calendar_version c ON (c.tenant_id,c.unit_id,c.version)=(u.tenant_id,u.id,u.calendar_version)
         LEFT JOIN domain.unit_usage_rules r ON (r.tenant_id,r.unit_id,r.version)=(u.tenant_id,u.id,u.usage_rules_version)
         WHERE u.tenant_id=$1 ORDER BY u.name,u.id LIMIT $2`,
        [tenantId, limit + 1],
      );
      if (facilities.rows.length > limit || units.rows.length > limit)
        throw new HttpError("PAYLOAD_TOO_LARGE");
      const at = (value: Date | null) => value?.toISOString() ?? null;
      return {
        format: "quenda.catalog",
        version: 1,
        tenantId,
        generatedAt: new Date().toISOString(),
        municipality: {
          name: municipality.name,
          timeZone: municipality.timezone,
          bookingPolicy: {
            version: municipality.booking_policy_version,
            advanceDays: municipality.advance_days,
            cancellationMinutes: municipality.cancellation_minutes,
          },
          appearance: {
            lightPalette: municipality.light_palette,
            darkPalette: municipality.dark_palette,
            defaultTheme: municipality.default_theme,
          },
        },
        facilities: facilities.rows.map((row) => ({
          id: row.id,
          name: row.name,
          publishedAt: at(row.published_at),
          withdrawnAt: at(row.withdrawn_at),
          profile: row.profile,
        })),
        units: units.rows.map((row) => ({
          id: row.id,
          facilityId: row.facility_id,
          name: row.name,
          publishedAt: at(row.published_at),
          withdrawnAt: at(row.withdrawn_at),
          profile: row.profile,
          calendar:
            row.calendar_version === null
              ? null
              : {
                  version: row.calendar_version,
                  minimumMinutes: row.minimum_minutes,
                  maximumMinutes: row.maximum_minutes,
                  stepMinutes: row.step_minutes,
                  advanceDays: row.advance_days,
                  weekly: row.weekly,
                  exceptions: row.exceptions,
                },
          usageRules:
            row.rules_version === null
              ? null
              : { version: row.rules_version, text: row.rules_text },
        })),
      };
    },
  );
}
