import { randomUUID } from "node:crypto";
import { DatabaseError, type Pool, type PoolClient } from "pg";
import { defaultIdempotencyRetentionSeconds } from "../../config.ts";
import { idempotentCommand } from "../../database/idempotency.ts";
import { HttpError } from "../../http/errors.ts";
import {
  type AuthenticatedAccount,
  palettes,
  requireAdministrator,
} from "../identity/index.ts";
import { type UnitCalendarInput, validateUnitCalendar } from "./calendar.ts";
import {
  type FacilityProfile,
  normalizeFacilityProfile,
  normalizeUnitProfile,
  type UnitProfile,
} from "./profile.ts";

/** The parts of a quenda.catalog v1 document that the import reads. */
export interface CatalogDocument {
  format: "quenda.catalog";
  version: 1;
  municipality: {
    bookingPolicy: { advanceDays: number; cancellationMinutes: number };
    appearance: {
      lightPalette: string;
      darkPalette: string;
      defaultTheme: string;
    };
  };
  facilities: {
    id: string;
    name: string;
    withdrawnAt: string | null;
    profile: FacilityProfile;
  }[];
  units: {
    id: string;
    facilityId: string;
    name: string;
    withdrawnAt: string | null;
    profile: UnitProfile;
    calendar: (UnitCalendarInput & { version: number }) | null;
    usageRules: { version: number; text: string } | null;
  }[];
}

const reason = "Importado de quenda.catalog";
const maximum = { facilities: 500, units: 2000 };

function title(value: string) {
  const normalized = value.trim();
  if (!normalized || normalized.length > 200)
    throw new HttpError("INVALID_INPUT");
  return normalized;
}
function rules(text: string) {
  if (!text.trim() || text.length > 20000 || text.includes("\0"))
    throw new HttpError("INVALID_INPUT");
  return text;
}

function settingsOf(document: CatalogDocument) {
  const { bookingPolicy, appearance } = document.municipality;
  const bounded = (n: number) =>
    Number.isInteger(n) && n >= 0 && n <= 2147483647;
  if (
    !bounded(bookingPolicy.advanceDays) ||
    !bounded(bookingPolicy.cancellationMinutes) ||
    !(palettes as readonly string[]).includes(appearance.lightPalette) ||
    !(palettes as readonly string[]).includes(appearance.darkPalette) ||
    !["light", "dark"].includes(appearance.defaultTheme)
  )
    throw new HttpError("INVALID_INPUT");
  return { bookingPolicy, appearance };
}

/**
 * Loads an exported catalog into a municipality that has no facilities yet, as
 * unpublished drafts with new identifiers. Withdrawn resources and publication
 * state are not imported; reservations never travel. With `settings`, the
 * booking policy and appearance of the document replace the municipality's own,
 * through the same audited functions as a manual edit and before calendars are
 * checked against the advance limit.
 */
export async function importCatalog(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  document: CatalogDocument,
  key: string = randomUUID(),
  retentionSeconds = defaultIdempotencyRetentionSeconds,
  settings = false,
) {
  const municipalSettings = settings ? settingsOf(document) : null;
  const facilities = document.facilities
    .filter((facility) => facility.withdrawnAt === null)
    .map((facility) => ({
      source: facility.id,
      name: title(facility.name),
      profile: normalizeFacilityProfile(facility.profile),
    }));
  const kept = new Set(facilities.map((facility) => facility.source));
  if (
    new Set(document.facilities.map((f) => f.id)).size !==
    document.facilities.length
  )
    throw new HttpError("INVALID_INPUT");
  const units = document.units
    .filter((unit) => unit.withdrawnAt === null && kept.has(unit.facilityId))
    .map((unit) => ({
      facility: unit.facilityId,
      name: title(unit.name),
      profile: normalizeUnitProfile(unit.profile),
      calendar: unit.calendar,
      rules: unit.usageRules ? rules(unit.usageRules.text) : null,
    }));
  if (
    document.units.some(
      (unit) => !document.facilities.some((f) => f.id === unit.facilityId),
    ) ||
    facilities.length > maximum.facilities ||
    units.length > maximum.units
  )
    throw new HttpError("INVALID_INPUT");
  const skipped =
    document.facilities.length -
    facilities.length +
    document.units.length -
    units.length;
  try {
    return await idempotentCommand(
      pool,
      { accountId: actor.accountId, tenantId },
      {
        operation: "catalog.import",
        key,
        retentionSeconds,
        // The option is part of the request: the same key with another choice is
        // a different command. Without it the input stays the bare document.
        input: (settings
          ? { document, settings }
          : document) as unknown as Parameters<
          typeof idempotentCommand
        >[2]["input"],
        authorize: (client) => requireAdministrator(client, actor),
        execute: async (client) => {
          const existing = await client.query(
            "SELECT 1 FROM domain.facility WHERE tenant_id=$1 LIMIT 1",
            [tenantId],
          );
          if (existing.rowCount) throw new HttpError("CONFLICT");
          const municipality = (
            await client.query<{
              advance_days: number;
              cancellation_minutes: number;
              booking_policy_version: number;
              appearance_version: number;
              light_palette: string;
              dark_palette: string;
              default_theme: string;
            }>(
              "SELECT advance_days,cancellation_minutes,booking_policy_version,appearance_version,light_palette,dark_palette,default_theme FROM domain.municipality WHERE id=$1",
              [tenantId],
            )
          ).rows[0];
          if (!municipality) throw new HttpError("NOT_FOUND");
          const correlation = randomUUID();
          const applied = { bookingPolicy: false, appearance: false };
          if (municipalSettings) {
            const { bookingPolicy, appearance } = municipalSettings;
            // Identical values are left untouched: no new version, no event.
            if (
              bookingPolicy.advanceDays !== municipality.advance_days ||
              bookingPolicy.cancellationMinutes !==
                municipality.cancellation_minutes
            ) {
              const version = (
                await client.query<{ version: number | null }>(
                  "SELECT domain.save_municipal_booking_policy($1,$2,$3,$4,$5) AS version",
                  [
                    municipality.booking_policy_version,
                    bookingPolicy.advanceDays,
                    bookingPolicy.cancellationMinutes,
                    reason,
                    correlation,
                  ],
                )
              ).rows[0]?.version;
              if (version == null) throw new HttpError("CONFLICT");
              municipality.advance_days = bookingPolicy.advanceDays;
              applied.bookingPolicy = true;
            }
            if (
              appearance.lightPalette !== municipality.light_palette ||
              appearance.darkPalette !== municipality.dark_palette ||
              appearance.defaultTheme !== municipality.default_theme
            ) {
              const version = (
                await client.query<{ version: number | null }>(
                  "SELECT domain.save_municipal_appearance($1,$2,$3,$4,$5) AS version",
                  [
                    municipality.appearance_version,
                    appearance.lightPalette,
                    appearance.darkPalette,
                    appearance.defaultTheme,
                    correlation,
                  ],
                )
              ).rows[0]?.version;
              if (version == null) throw new HttpError("CONFLICT");
              applied.appearance = true;
            }
          }
          const ids = new Map<string, string>();
          for (const facility of facilities) {
            const id = randomUUID();
            ids.set(facility.source, id);
            await client.query(
              "INSERT INTO domain.facility (tenant_id,id,name) VALUES ($1,$2,$3)",
              [tenantId, id, facility.name],
            );
            await event(client, tenantId, actor, id, null, "CREATE_FACILITY");
            await facilityProfile(
              client,
              tenantId,
              actor,
              id,
              facility.profile,
              correlation,
            );
          }
          let calendars = 0,
            usageRules = 0;
          for (const unit of units) {
            const facilityId = ids.get(unit.facility);
            if (!facilityId) throw new HttpError("INVALID_INPUT");
            const id = randomUUID();
            await client.query(
              "INSERT INTO domain.reservable_unit (tenant_id,id,facility_id,name) VALUES ($1,$2,$3,$4)",
              [tenantId, id, facilityId, unit.name],
            );
            await event(client, tenantId, actor, facilityId, id, "CREATE_UNIT");
            await unitProfile(
              client,
              tenantId,
              actor,
              facilityId,
              id,
              unit.profile,
              correlation,
            );
            if (unit.calendar) {
              const { version: _version, ...input } = unit.calendar;
              const calendar = validateUnitCalendar(
                input,
                municipality.advance_days,
              );
              await client.query(
                `INSERT INTO domain.unit_calendar_version(tenant_id,unit_id,version,minimum_minutes,maximum_minutes,step_minutes,advance_days,weekly,exceptions,actor_id,reason)
                 VALUES ($1,$2,1,$3,$4,$5,$6,$7,$8,$9,$10)`,
                [
                  tenantId,
                  id,
                  calendar.minimumMinutes,
                  calendar.maximumMinutes,
                  calendar.stepMinutes,
                  calendar.advanceDays,
                  JSON.stringify(calendar.weekly),
                  JSON.stringify(calendar.exceptions),
                  actor.accountId,
                  reason,
                ],
              );
              await client.query(
                "UPDATE domain.reservable_unit SET calendar_version=1 WHERE tenant_id=$1 AND id=$2",
                [tenantId, id],
              );
              calendars++;
            }
            if (unit.rules) {
              const saved = (
                await client.query<{ version: number | null }>(
                  "SELECT domain.save_unit_usage_rules($1,0,$2,$3,$4) AS version",
                  [id, unit.rules, reason, correlation],
                )
              ).rows[0];
              if (saved?.version !== 1) throw new HttpError("CONFLICT");
              usageRules++;
            }
          }
          return {
            tenantId,
            facilities: facilities.length,
            units: units.length,
            calendars,
            usageRules,
            skippedWithdrawn: skipped,
            settings: applied,
          };
        },
      },
    ).then(({ result }) => ({
      ...result,
      // Results stored before settings could travel replay as "nothing applied".
      settings: result.settings ?? { bookingPolicy: false, appearance: false },
    }));
  } catch (error) {
    if (error instanceof DatabaseError && error.code === "23514")
      throw new HttpError("INVALID_INPUT");
    throw error;
  }
}

async function event(
  client: PoolClient,
  tenantId: string,
  actor: AuthenticatedAccount,
  facilityId: string,
  unitId: string | null,
  operation: "CREATE_FACILITY" | "CREATE_UNIT",
) {
  await client.query(
    "INSERT INTO domain.catalog_event (tenant_id,id,actor_id,facility_id,unit_id,operation) VALUES ($1,$2,$3,$4,$5,$6)",
    [tenantId, randomUUID(), actor.accountId, facilityId, unitId, operation],
  );
}

const empty = (profile: Record<string, unknown>) =>
  Object.values(profile).every((value) => value === null);

// A new resource has an empty profile at version 1; a non-empty imported profile
// becomes version 2 with an audited event, exactly as a first manual edit would.
async function facilityProfile(
  client: PoolClient,
  tenantId: string,
  actor: AuthenticatedAccount,
  id: string,
  profile: ReturnType<typeof normalizeFacilityProfile>,
  correlation: string,
) {
  if (empty(profile)) return;
  const previous = await profileJson(client, tenantId, "facility", id);
  await client.query(
    `UPDATE domain.facility SET address=$3,postal_code=$4,latitude=$5,longitude=$6,description_gl=$7,description_es=$8,
     accessibility_gl=$9,accessibility_es=$10,contact_phone=$11,contact_email=$12,profile_version=2 WHERE tenant_id=$1 AND id=$2`,
    [
      tenantId,
      id,
      profile.address,
      profile.postalCode,
      profile.latitude,
      profile.longitude,
      profile.descriptionGl,
      profile.descriptionEs,
      profile.accessibilityGl,
      profile.accessibilityEs,
      profile.contactPhone,
      profile.contactEmail,
    ],
  );
  await profileEvent(client, tenantId, actor, id, null, previous, correlation);
}
async function unitProfile(
  client: PoolClient,
  tenantId: string,
  actor: AuthenticatedAccount,
  facilityId: string,
  id: string,
  profile: ReturnType<typeof normalizeUnitProfile>,
  correlation: string,
) {
  if (empty(profile)) return;
  const previous = await profileJson(client, tenantId, "unit", id);
  await client.query(
    `UPDATE domain.reservable_unit SET kind=$3,indoor=$4,capacity=$5,description_gl=$6,description_es=$7,profile_version=2
     WHERE tenant_id=$1 AND id=$2`,
    [
      tenantId,
      id,
      profile.kind,
      profile.indoor,
      profile.capacity,
      profile.descriptionGl,
      profile.descriptionEs,
    ],
  );
  await profileEvent(
    client,
    tenantId,
    actor,
    facilityId,
    id,
    previous,
    correlation,
  );
}
async function profileJson(
  client: PoolClient,
  tenantId: string,
  kind: "facility" | "unit",
  id: string,
) {
  return (
    await client.query<{ profile: unknown }>(
      kind === "facility"
        ? "SELECT domain.facility_profile_json(f) AS profile FROM domain.facility f WHERE f.tenant_id=$1 AND f.id=$2"
        : "SELECT domain.unit_profile_json(u) AS profile FROM domain.reservable_unit u WHERE u.tenant_id=$1 AND u.id=$2",
      [tenantId, id],
    )
  ).rows[0]?.profile;
}
async function profileEvent(
  client: PoolClient,
  tenantId: string,
  actor: AuthenticatedAccount,
  facilityId: string,
  unitId: string | null,
  previous: unknown,
  correlation: string,
) {
  const next = await profileJson(
    client,
    tenantId,
    unitId ? "unit" : "facility",
    unitId ?? facilityId,
  );
  await client.query(
    "INSERT INTO domain.catalog_profile_event(tenant_id,id,actor_id,facility_id,unit_id,version,previous_state,next_state,correlation_id) VALUES($1,$2,$3,$4,$5,2,$6,$7,$8)",
    [
      tenantId,
      randomUUID(),
      actor.accountId,
      facilityId,
      unitId,
      JSON.stringify(previous),
      JSON.stringify(next),
      correlation,
    ],
  );
}
