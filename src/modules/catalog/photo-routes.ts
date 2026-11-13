import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import {
  type AuthConfiguration,
  type Authentication,
  createRequestActor,
} from "../identity/index.ts";
import { photoMaximumBytes } from "./photo-image.ts";
import {
  addCatalogPhoto,
  catalogPhotoContent,
  describeCatalogPhoto,
  maximumPhotos,
  orderCatalogPhotos,
  type PhotoSize,
  removeCatalogPhoto,
} from "./photos.ts";

const uuid = { type: "string", format: "uuid" } as const;
const alt = {
  type: "object",
  additionalProperties: false,
  required: ["gl", "es"],
  properties: {
    gl: { type: "string", minLength: 1, maxLength: 250 },
    es: { type: "string", minLength: 1, maxLength: 250 },
  },
} as const;
export const photoSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "alt", "width", "height"],
  properties: {
    id: uuid,
    alt,
    width: { type: "integer", minimum: 1 },
    height: { type: "integer", minimum: 1 },
  },
} as const;
export const photoListSchema = {
  type: "array",
  maxItems: maximumPhotos,
  items: photoSchema,
} as const;
export const photoSizes = ["large", "small"] as const;
export const photoContentResponse = {
  description:
    "Imagen WebP 3:2. large mide hasta 1500 × 1000 px; small, 600 × 400 px.",
  content: { "image/webp": { schema: { type: "string", format: "binary" } } },
} as const;

/**
 * Sends photo bytes. A photo never changes its image (a new image is a new
 * photo), so the id and size identify the bytes and revalidation is cheap.
 */
export async function sendPhoto(
  request: FastifyRequest,
  reply: FastifyReply,
  photoId: string,
  size: PhotoSize,
  cacheControl: string,
  content: () => Promise<Buffer>,
) {
  // The content is read even to revalidate, so a removed or unpublished photo answers 404.
  const bytes = await content();
  const etag = `"${photoId}-${size}"`;
  reply.header("etag", etag).header("cache-control", cacheControl);
  if (request.headers["if-none-match"] === etag) return reply.code(304).send();
  return reply
    .type("image/webp")
    .header("content-disposition", "inline")
    .send(bytes);
}

const errors = Object.fromEntries(
  [400, 401, 403, 404, 409, 429, 500, 503].map((status) => [
    status,
    { $ref: "ErrorResponse#" },
  ]),
);
const photosResponse = {
  ...errors,
  200: {
    type: "object",
    additionalProperties: false,
    required: ["photos"],
    properties: { photos: photoListSchema },
  },
};

export async function registerCatalogPhotoRoutes(
  app: FastifyInstance,
  pool: Pool,
  auth: Authentication,
  config: AuthConfiguration,
) {
  const actor = createRequestActor(pool, auth, config);
  for (const kind of ["facility", "unit"] as const) {
    const resource = kind === "facility" ? "facilities" : "units";
    const base = `/api/municipalities/:tenantId/${resource}/:id/photos`;
    const params = {
      type: "object",
      additionalProperties: false,
      required: ["tenantId", "id"],
      properties: { tenantId: uuid, id: uuid },
    };
    const photoParams = {
      ...params,
      required: [...params.required, "photoId"],
      properties: { ...params.properties, photoId: uuid },
    };
    const permission =
      kind === "facility"
        ? "CATALOG_MANAGE sobre el municipio"
        : "CATALOG_MANAGE sobre la unidad";

    app.post<{
      Params: { tenantId: string; id: string };
      Body: { image: string; alt: { gl: string; es: string } };
    }>(
      base,
      {
        // The image travels in base64 inside JSON: up to 6 MiB of file.
        bodyLimit: Math.ceil((photoMaximumBytes * 4) / 3) + 64 * 1024,
        schema: {
          operationId: `add_${kind}_photo`,
          tags: ["Catalog"],
          security: [{ quendaSession: [] }],
          description: `Añade una fotografía al final de la lista; la primera es la portada. image es un JPEG, PNG o WebP en base64 de hasta 6 MiB, horizontal (al menos 4:3) y de al menos 900 × 600 px una vez encuadrado a 3:2. El servidor guarda solo su propia versión WebP 3:2, centrada, en dos tamaños y sin metadatos; nunca el archivo recibido. alt es la descripción obligatoria en gallego y castellano. Máximo ${maximumPhotos}. Exige ${permission} y MFA reciente. Queda auditado.`,
          params,
          body: {
            type: "object",
            additionalProperties: false,
            required: ["image", "alt"],
            properties: {
              image: {
                type: "string",
                minLength: 16,
                maxLength: Math.ceil((photoMaximumBytes * 4) / 3) + 4,
              },
              alt,
            },
          },
          response: photosResponse,
        },
      },
      async (request, reply) =>
        addCatalogPhoto(
          pool,
          await actor(request, reply),
          request.params.tenantId,
          kind,
          request.params.id,
          request.body,
          request.id,
        ),
    );

    app.put<{
      Params: { tenantId: string; id: string };
      Body: { photoIds: string[] };
    }>(
      `${base}/order`,
      {
        schema: {
          operationId: `order_${kind}_photos`,
          tags: ["Catalog"],
          security: [{ quendaSession: [] }],
          description: `Fija el orden de todas las fotografías; la primera pasa a ser la portada. photoIds debe contener exactamente las fotografías actuales; si no coincide, responde CONFLICT. Exige ${permission} y MFA reciente.`,
          params,
          body: {
            type: "object",
            additionalProperties: false,
            required: ["photoIds"],
            properties: {
              photoIds: {
                type: "array",
                minItems: 1,
                maxItems: maximumPhotos,
                items: uuid,
              },
            },
          },
          response: photosResponse,
        },
      },
      async (request, reply) =>
        orderCatalogPhotos(
          pool,
          await actor(request, reply),
          request.params.tenantId,
          kind,
          request.params.id,
          request.body.photoIds,
          request.id,
        ),
    );

    app.patch<{
      Params: { tenantId: string; id: string; photoId: string };
      Body: { alt: { gl: string; es: string } };
    }>(
      `${base}/:photoId`,
      {
        schema: {
          operationId: `describe_${kind}_photo`,
          tags: ["Catalog"],
          security: [{ quendaSession: [] }],
          description: `Sustituye la descripción de una fotografía. Exige ${permission} y MFA reciente.`,
          params: photoParams,
          body: {
            type: "object",
            additionalProperties: false,
            required: ["alt"],
            properties: { alt },
          },
          response: photosResponse,
        },
      },
      async (request, reply) =>
        describeCatalogPhoto(
          pool,
          await actor(request, reply),
          request.params.tenantId,
          kind,
          request.params.id,
          request.params.photoId,
          request.body,
          request.id,
        ),
    );

    app.delete<{
      Params: { tenantId: string; id: string; photoId: string };
    }>(
      `${base}/:photoId`,
      {
        schema: {
          operationId: `remove_${kind}_photo`,
          tags: ["Catalog"],
          security: [{ quendaSession: [] }],
          description: `Elimina una fotografía y su imagen; las siguientes suben un puesto. Exige ${permission} y MFA reciente.`,
          params: photoParams,
          response: photosResponse,
        },
      },
      async (request, reply) =>
        removeCatalogPhoto(
          pool,
          await actor(request, reply),
          request.params.tenantId,
          kind,
          request.params.id,
          request.params.photoId,
          request.id,
        ),
    );

    app.get<{
      Params: {
        tenantId: string;
        id: string;
        photoId: string;
        size: PhotoSize;
      };
    }>(
      `${base}/:photoId/:size`,
      {
        schema: {
          operationId: `${kind}_photo_content`,
          tags: ["Catalog"],
          security: [{ quendaSession: [] }],
          description:
            "Imagen de una fotografía para el editor, también de recursos sin publicar. Exige sesión con MFA y permiso de catálogo sobre el recurso.",
          params: {
            ...photoParams,
            required: [...photoParams.required, "size"],
            properties: {
              ...photoParams.properties,
              size: { type: "string", enum: photoSizes },
            },
          },
          response: { ...errors, 200: photoContentResponse },
        },
      },
      async (request, reply) => {
        const account = await actor(request, reply);
        return sendPhoto(
          request,
          reply,
          request.params.photoId,
          request.params.size,
          "private, max-age=3600",
          () =>
            catalogPhotoContent(
              pool,
              account,
              request.params.tenantId,
              kind,
              request.params.id,
              request.params.photoId,
              request.params.size,
            ),
        );
      },
    );
  }
}
