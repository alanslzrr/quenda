import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { command } from "../../database/command.ts";
import { HttpError } from "../../http/errors.ts";
import {
  type AuthenticatedAccount,
  requireMfaSession,
  requirePermission,
  requireRecentMfa,
} from "../identity/index.ts";
import { processPhoto } from "./photo-image.ts";

export const maximumPhotos = 6;
export type PhotoOwner = "facility" | "unit";
export type PhotoSize = "large" | "small";
type Localized = { gl: string; es: string };
export interface CatalogPhoto {
  id: string;
  alt: Localized;
  width: number;
  height: number;
}
interface PhotoRow {
  id: string;
  alt_gl: string;
  alt_es: string;
  width: number;
  height: number;
}
const toPhoto = (row: PhotoRow): CatalogPhoto => ({
  id: row.id,
  alt: { gl: row.alt_gl, es: row.alt_es },
  width: row.width,
  height: row.height,
});

// The text alternative is the photo's description for screen readers and its
// caption in the viewer, so both languages are required.
function cleanAlt(alt: Partial<Localized> | undefined): Localized {
  const gl = alt?.gl?.trim() ?? "";
  const es = alt?.es?.trim() ?? "";
  if (!gl || !es || gl.length > 250 || es.length > 250)
    throw new HttpError("INVALID_INPUT");
  return { gl, es };
}

// Base64 alphabet only; Buffer.from would otherwise skip stray characters silently.
const base64 = /^[A-Za-z0-9+/]*={0,2}$/;
function decode(image: string): Buffer {
  if (image.length % 4 !== 0 || !base64.test(image))
    throw new HttpError("PHOTO_INVALID");
  return Buffer.from(image, "base64");
}

const ownerFilter = (kind: PhotoOwner) =>
  kind === "facility" ? "facility_id=$2 AND unit_id IS NULL" : "unit_id=$2";

async function listOwned(
  client: PoolClient,
  tenantId: string,
  kind: PhotoOwner,
  id: string,
): Promise<CatalogPhoto[]> {
  const result = await client.query<PhotoRow>(
    `SELECT id,alt_gl,alt_es,width,height FROM domain.catalog_photo WHERE tenant_id=$1 AND ${ownerFilter(kind)} ORDER BY position`,
    [tenantId, id],
  );
  return result.rows.map(toPhoto);
}
export const listCatalogPhotos = listOwned;

/** Locks the facility or unit so concurrent changes to its photos serialize. */
async function lockOwner(
  client: PoolClient,
  tenantId: string,
  kind: PhotoOwner,
  id: string,
): Promise<{ facilityId: string; unitId: string | null }> {
  const row = (
    await client.query<{ facility_id: string }>(
      kind === "facility"
        ? "SELECT id AS facility_id FROM domain.facility WHERE tenant_id=$1 AND id=$2 FOR UPDATE"
        : "SELECT facility_id FROM domain.reservable_unit WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
      [tenantId, id],
    )
  ).rows[0];
  if (!row) throw new HttpError("NOT_FOUND");
  return { facilityId: row.facility_id, unitId: kind === "unit" ? id : null };
}

async function record(
  client: PoolClient,
  actor: AuthenticatedAccount,
  tenantId: string,
  owner: { facilityId: string; unitId: string | null },
  photoId: string,
  action: "ADDED" | "DESCRIBED" | "MOVED" | "REMOVED",
  previous: unknown,
  next: unknown,
  correlationId: string,
) {
  await client.query(
    "INSERT INTO domain.catalog_photo_event(tenant_id,id,actor_id,facility_id,unit_id,photo_id,action,previous_state,next_state,correlation_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
    [
      tenantId,
      randomUUID(),
      actor.accountId,
      owner.facilityId,
      owner.unitId,
      photoId,
      action,
      previous === null ? null : JSON.stringify(previous),
      next === null ? null : JSON.stringify(next),
      correlationId,
    ],
  );
}

function change<T>(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  kind: PhotoOwner,
  id: string,
  operation: (
    client: PoolClient,
    owner: { facilityId: string; unitId: string | null },
  ) => Promise<T>,
) {
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
      const owner = await lockOwner(client, tenantId, kind, id);
      await operation(client, owner);
      return { photos: await listOwned(client, tenantId, kind, id) };
    },
  );
}

/** Adds a photo at the end of the list; the first one is the cover. */
export async function addCatalogPhoto(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  kind: PhotoOwner,
  id: string,
  input: { image: string; alt: Localized },
  correlationId: string = randomUUID(),
) {
  const alt = cleanAlt(input.alt);
  // Authorization is checked before the CPU-bound work, and again in the transaction.
  requireRecentMfa(actor);
  const photo = await processPhoto(decode(input.image));
  return change(pool, actor, tenantId, kind, id, async (client, owner) => {
    const count = (
      await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM domain.catalog_photo WHERE tenant_id=$1 AND ${ownerFilter(kind)}`,
        [tenantId, id],
      )
    ).rows[0]?.count;
    if ((count ?? 0) >= maximumPhotos)
      throw new HttpError("PHOTO_LIMIT_REACHED");
    const photoId = randomUUID();
    const position = (count ?? 0) + 1;
    await client.query(
      "INSERT INTO domain.catalog_photo(tenant_id,id,facility_id,unit_id,position,alt_gl,alt_es,width,height,large,small) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
      [
        tenantId,
        photoId,
        owner.facilityId,
        owner.unitId,
        position,
        alt.gl,
        alt.es,
        photo.width,
        photo.height,
        photo.large,
        photo.small,
      ],
    );
    await record(
      client,
      actor,
      tenantId,
      owner,
      photoId,
      "ADDED",
      null,
      {
        position,
        alt,
      },
      correlationId,
    );
  });
}

export async function describeCatalogPhoto(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  kind: PhotoOwner,
  id: string,
  photoId: string,
  input: { alt: Localized },
  correlationId: string = randomUUID(),
) {
  const alt = cleanAlt(input.alt);
  return change(pool, actor, tenantId, kind, id, async (client, owner) => {
    const current = (
      await client.query<{ alt_gl: string; alt_es: string }>(
        `SELECT alt_gl,alt_es FROM domain.catalog_photo WHERE tenant_id=$1 AND ${ownerFilter(kind)} AND id=$3`,
        [tenantId, id, photoId],
      )
    ).rows[0];
    if (!current) throw new HttpError("NOT_FOUND");
    if (current.alt_gl === alt.gl && current.alt_es === alt.es) return;
    await client.query(
      "UPDATE domain.catalog_photo SET alt_gl=$3,alt_es=$4 WHERE tenant_id=$1 AND id=$2",
      [tenantId, photoId, alt.gl, alt.es],
    );
    await record(
      client,
      actor,
      tenantId,
      owner,
      photoId,
      "DESCRIBED",
      { alt: { gl: current.alt_gl, es: current.alt_es } },
      { alt },
      correlationId,
    );
  });
}

/** Sets the order of every photo of a facility or unit; the first becomes the cover. */
export async function orderCatalogPhotos(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  kind: PhotoOwner,
  id: string,
  photoIds: string[],
  correlationId: string = randomUUID(),
) {
  if (new Set(photoIds).size !== photoIds.length)
    throw new HttpError("INVALID_INPUT");
  return change(pool, actor, tenantId, kind, id, async (client, owner) => {
    const current = await listOwned(client, tenantId, kind, id);
    // Only a complete permutation of the current list is accepted, so a client
    // that missed an addition or a removal does not reorder a different list.
    if (
      current.length !== photoIds.length ||
      current.some((photo) => !photoIds.includes(photo.id))
    )
      throw new HttpError("CONFLICT");
    for (const [index, photoId] of photoIds.entries()) {
      const previous = current.findIndex((photo) => photo.id === photoId) + 1;
      const position = index + 1;
      if (previous === position) continue;
      await client.query(
        "UPDATE domain.catalog_photo SET position=$3 WHERE tenant_id=$1 AND id=$2",
        [tenantId, photoId, position],
      );
      await record(
        client,
        actor,
        tenantId,
        owner,
        photoId,
        "MOVED",
        { position: previous },
        { position },
        correlationId,
      );
    }
  });
}

export async function removeCatalogPhoto(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  kind: PhotoOwner,
  id: string,
  photoId: string,
  correlationId: string = randomUUID(),
) {
  return change(pool, actor, tenantId, kind, id, async (client, owner) => {
    const removed = (
      await client.query<{ position: number; alt_gl: string; alt_es: string }>(
        `DELETE FROM domain.catalog_photo WHERE tenant_id=$1 AND ${ownerFilter(kind)} AND id=$3 RETURNING position,alt_gl,alt_es`,
        [tenantId, id, photoId],
      )
    ).rows[0];
    if (!removed) throw new HttpError("NOT_FOUND");
    // The photos after it move up, so positions stay 1..n and the cover is always the first.
    await client.query(
      `UPDATE domain.catalog_photo SET position=position-1 WHERE tenant_id=$1 AND ${ownerFilter(kind)} AND position>$3`,
      [tenantId, id, removed.position],
    );
    await record(
      client,
      actor,
      tenantId,
      owner,
      photoId,
      "REMOVED",
      {
        position: removed.position,
        alt: { gl: removed.alt_gl, es: removed.alt_es },
      },
      null,
      correlationId,
    );
  });
}

/**
 * The image of a photo for the administrative editor, including resources that
 * are not published yet. Row security limits it to who may maintain them.
 */
export async function catalogPhotoContent(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  kind: PhotoOwner,
  id: string,
  photoId: string,
  size: PhotoSize,
): Promise<Buffer> {
  requireMfaSession(actor);
  return command(
    pool,
    { accountId: actor.accountId, tenantId },
    async (client) => {
      const row = (
        await client.query<{ content: Buffer }>(
          `SELECT ${size === "large" ? "large" : "small"} AS content FROM domain.catalog_photo WHERE tenant_id=$1 AND ${ownerFilter(kind)} AND id=$3`,
          [tenantId, id, photoId],
        )
      ).rows[0];
      if (!row) throw new HttpError("NOT_FOUND");
      return row.content;
    },
  );
}

/** Photos of published facilities and units, grouped by the facility or unit id. */
export async function publicPhotos(
  pool: Pool | PoolClient,
  tenantId: string,
  owners: string[],
): Promise<Map<string, CatalogPhoto[]>> {
  const grouped = new Map<string, CatalogPhoto[]>();
  if (!owners.length) return grouped;
  const result = await pool.query<PhotoRow & { owner_id: string }>(
    "SELECT * FROM domain.public_catalog_photos($1,$2)",
    [tenantId, owners],
  );
  for (const row of result.rows) {
    const list = grouped.get(row.owner_id) ?? [];
    list.push(toPhoto(row));
    grouped.set(row.owner_id, list);
  }
  return grouped;
}

export async function publicPhotoContent(
  pool: Pool,
  tenantId: string,
  photoId: string,
  size: PhotoSize,
): Promise<Buffer> {
  const row = (
    await pool.query<{ content: Buffer | null }>(
      "SELECT domain.public_catalog_photo_content($1,$2,$3) AS content",
      [tenantId, photoId, size === "large"],
    )
  ).rows[0];
  if (!row?.content) throw new HttpError("NOT_FOUND");
  return row.content;
}
