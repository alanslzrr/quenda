import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { command } from "../../database/command.ts";
import { HttpError } from "../../http/errors.ts";
import {
  type AuthenticatedAccount,
  requirePermission,
} from "../identity/index.ts";
import { type UnitKind, unitKinds } from "./profile-schema.ts";

type Localized = { gl?: string; es?: string };
export interface FacilityProfile {
  address?: string;
  postalCode?: string;
  location?: { latitude: number; longitude: number };
  description?: Localized;
  accessibility?: Localized;
  contact?: { phone?: string; email?: string };
}
export interface UnitProfile {
  kind?: UnitKind;
  indoor?: boolean;
  capacity?: number;
  description?: Localized;
}
export type FacilityProfileInput = FacilityProfile & {
  expectedVersion: number;
};
export type UnitProfileInput = UnitProfile & { expectedVersion: number };

const email = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const phone = /^[0-9+() .-]{3,30}$/;

// Blank text means "not provided": it is stored as absent, never as an empty string.
function clean(value: string | undefined, max: number): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > max) throw new HttpError("INVALID_INPUT");
  return trimmed;
}
function version(value: number) {
  if (!Number.isInteger(value) || value < 1 || value >= 2147483647)
    throw new HttpError("INVALID_INPUT");
}

export function normalizeFacilityProfile(input: FacilityProfile) {
  const address = clean(input.address, 300);
  const postalCode = clean(input.postalCode, 5);
  if (postalCode && !/^[0-9]{5}$/.test(postalCode))
    throw new HttpError("INVALID_INPUT");
  const location = input.location;
  if (
    location &&
    (!Number.isFinite(location.latitude) ||
      !Number.isFinite(location.longitude) ||
      Math.abs(location.latitude) > 90 ||
      Math.abs(location.longitude) > 180)
  )
    throw new HttpError("INVALID_INPUT");
  const contactPhone = clean(input.contact?.phone, 30);
  const contactEmail = clean(input.contact?.email, 254);
  if (contactPhone && !phone.test(contactPhone))
    throw new HttpError("INVALID_INPUT");
  if (contactEmail && !email.test(contactEmail))
    throw new HttpError("INVALID_INPUT");
  return {
    address,
    postalCode,
    // Six decimals is about a tenth of a metre; more only invites false precision.
    latitude: location ? Number(location.latitude.toFixed(6)) : null,
    longitude: location ? Number(location.longitude.toFixed(6)) : null,
    descriptionGl: clean(input.description?.gl, 1000),
    descriptionEs: clean(input.description?.es, 1000),
    accessibilityGl: clean(input.accessibility?.gl, 1000),
    accessibilityEs: clean(input.accessibility?.es, 1000),
    contactPhone,
    contactEmail,
  };
}
export function normalizeUnitProfile(input: UnitProfile) {
  if (input.kind !== undefined && !unitKinds.includes(input.kind))
    throw new HttpError("INVALID_INPUT");
  if (
    input.capacity !== undefined &&
    (!Number.isInteger(input.capacity) ||
      input.capacity < 1 ||
      input.capacity > 10000)
  )
    throw new HttpError("INVALID_INPUT");
  return {
    kind: input.kind ?? null,
    indoor: input.indoor ?? null,
    capacity: input.capacity ?? null,
    descriptionGl: clean(input.description?.gl, 1000),
    descriptionEs: clean(input.description?.es, 1000),
  };
}

/**
 * Replaces the whole profile of a facility or unit. A field that is absent is cleared,
 * so reading a profile, editing it and sending it back is the complete workflow.
 */
export async function saveCatalogProfile(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  kind: "facility" | "unit",
  id: string,
  input: FacilityProfileInput | UnitProfileInput,
  correlationId: string = randomUUID(),
): Promise<{ profile: FacilityProfile | UnitProfile; profileVersion: number }> {
  version(input.expectedVersion);
  const facility =
    kind === "facility"
      ? normalizeFacilityProfile(input as FacilityProfile)
      : null;
  const unit =
    kind === "unit" ? normalizeUnitProfile(input as UnitProfile) : null;
  return command(
    pool,
    { accountId: actor.accountId, tenantId },
    async (client) => {
      await requirePermission(
        client,
        actor,
        "CATALOG_MANAGE",
        kind === "unit" ? id : null,
      );
      const current = (
        await client.query<{
          profile_version: number;
          facility_id: string;
          profile: unknown;
        }>(
          kind === "facility"
            ? "SELECT f.profile_version,f.id AS facility_id,domain.facility_profile_json(f) AS profile FROM domain.facility f WHERE f.tenant_id=$1 AND f.id=$2 FOR UPDATE"
            : "SELECT u.profile_version,u.facility_id,domain.unit_profile_json(u) AS profile FROM domain.reservable_unit u WHERE u.tenant_id=$1 AND u.id=$2 FOR UPDATE",
          [tenantId, id],
        )
      ).rows[0];
      if (!current) throw new HttpError("NOT_FOUND");
      if (current.profile_version !== input.expectedVersion)
        throw new HttpError("CONFLICT");
      const next = current.profile_version + 1;
      if (facility)
        await client.query(
          `UPDATE domain.facility SET address=$3,postal_code=$4,latitude=$5,longitude=$6,description_gl=$7,description_es=$8,
           accessibility_gl=$9,accessibility_es=$10,contact_phone=$11,contact_email=$12,profile_version=$13 WHERE tenant_id=$1 AND id=$2`,
          [
            tenantId,
            id,
            facility.address,
            facility.postalCode,
            facility.latitude,
            facility.longitude,
            facility.descriptionGl,
            facility.descriptionEs,
            facility.accessibilityGl,
            facility.accessibilityEs,
            facility.contactPhone,
            facility.contactEmail,
            next,
          ],
        );
      else if (unit)
        await client.query(
          `UPDATE domain.reservable_unit SET kind=$3,indoor=$4,capacity=$5,description_gl=$6,description_es=$7,profile_version=$8
           WHERE tenant_id=$1 AND id=$2`,
          [
            tenantId,
            id,
            unit.kind,
            unit.indoor,
            unit.capacity,
            unit.descriptionGl,
            unit.descriptionEs,
            next,
          ],
        );
      const saved = (
        await client.query<{ profile: FacilityProfile | UnitProfile }>(
          kind === "facility"
            ? "SELECT domain.facility_profile_json(f) AS profile FROM domain.facility f WHERE f.tenant_id=$1 AND f.id=$2"
            : "SELECT domain.unit_profile_json(u) AS profile FROM domain.reservable_unit u WHERE u.tenant_id=$1 AND u.id=$2",
          [tenantId, id],
        )
      ).rows[0];
      if (!saved) throw new HttpError("NOT_FOUND");
      await client.query(
        "INSERT INTO domain.catalog_profile_event(tenant_id,id,actor_id,facility_id,unit_id,version,previous_state,next_state,correlation_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [
          tenantId,
          randomUUID(),
          actor.accountId,
          current.facility_id,
          kind === "unit" ? id : null,
          next,
          JSON.stringify(current.profile),
          JSON.stringify(saved.profile),
          correlationId,
        ],
      );
      return { profile: saved.profile, profileVersion: next };
    },
  );
}
