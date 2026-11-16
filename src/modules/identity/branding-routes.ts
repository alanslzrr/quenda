import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { publicRateLimit } from "../../http/public-rate-limit.ts";
import type { AuthConfiguration, Authentication } from "./auth.ts";
import {
  type LogoVariant,
  logoVariants,
  publicBranding,
  publicLogo,
  removeLogo,
  renameMunicipality,
  saveLogo,
} from "./branding.ts";
import { logoMaximumBytes } from "./logo-image.ts";
import { createRequestActor } from "./request-actor.ts";

const uuid = { type: "string", format: "uuid" } as const;
const version = { type: "integer", minimum: 1, maximum: 2147483646 } as const;
const errors = Object.fromEntries(
  [400, 401, 403, 404, 409, 413, 429, 500, 503].map((status) => [
    status,
    { $ref: "ErrorResponse#" },
  ]),
);
const branding = {
  ...errors,
  200: {
    type: "object",
    additionalProperties: false,
    required: ["version", "name", "officialName", "logos"],
    properties: {
      version: { type: "integer", minimum: 1 },
      name: { type: "string" },
      officialName: { type: "string" },
      logos: {
        type: "object",
        additionalProperties: false,
        required: ["light", "dark"],
        properties: { light: { type: "boolean" }, dark: { type: "boolean" } },
      },
    },
  },
};
const tenantParams = {
  type: "object",
  additionalProperties: false,
  required: ["tenantId"],
  properties: { tenantId: uuid },
} as const;
const logoParams = {
  type: "object",
  additionalProperties: false,
  required: ["tenantId", "variant"],
  properties: {
    tenantId: uuid,
    variant: { type: "string", enum: logoVariants },
  },
} as const;

export async function registerBrandingRoutes(
  app: FastifyInstance,
  pool: Pool,
  auth: Authentication,
  config: AuthConfiguration,
) {
  const actor = createRequestActor(pool, auth, config);

  app.get<{ Params: { tenantId: string } }>(
    "/api/public/municipalities/:tenantId/branding",
    {
      onRequest: publicRateLimit(pool, config.secret),
      schema: {
        operationId: "publicMunicipalBranding",
        tags: ["Identity"],
        security: [],
        description:
          "Nombre visible, nombre oficial con el que se dio de alta y logos disponibles del municipio. version cambia con cada cambio de nombre o de logo y sirve para pedir la imagen actual.",
        params: tenantParams,
        response: branding,
      },
    },
    (request) => publicBranding(pool, request.params.tenantId),
  );

  app.get<{ Params: { tenantId: string; variant: LogoVariant } }>(
    "/api/public/municipalities/:tenantId/logo/:variant",
    {
      onRequest: publicRateLimit(pool, config.secret),
      schema: {
        operationId: "publicMunicipalLogo",
        tags: ["Identity"],
        security: [],
        description:
          "Logo del municipio en WebP, hasta 512 px por el lado mayor, con transparencia. dark es la versión para fondos oscuros.",
        params: logoParams,
        response: {
          ...errors,
          200: {
            description: "Imagen WebP del logo.",
            content: {
              "image/webp": { schema: { type: "string", format: "binary" } },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const logo = await publicLogo(
        pool,
        request.params.tenantId,
        request.params.variant,
      );
      const etag = `"${logo.version}-${request.params.variant}"`;
      reply.header("etag", etag).header("cache-control", "public, max-age=300");
      if (request.headers["if-none-match"] === etag)
        return reply.code(304).send();
      return reply
        .type("image/webp")
        .header("content-disposition", "inline")
        .send(logo.image);
    },
  );

  app.put<{
    Params: { tenantId: string };
    Body: { expectedVersion: number; name: string };
  }>(
    "/api/municipalities/:tenantId/branding/name",
    {
      schema: {
        operationId: "renameMunicipality",
        tags: ["Identity"],
        security: [{ quendaSession: [] }],
        description:
          "Administrador municipal con MFA reciente. Cambia el nombre con el que el municipio aparece en toda la aplicación (1 a 120 caracteres, sin caracteres de control). El nombre oficial no cambia. Control de versión y auditoría.",
        params: tenantParams,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["expectedVersion", "name"],
          properties: {
            expectedVersion: version,
            name: { type: "string", minLength: 1, maxLength: 200 },
          },
        },
        response: branding,
      },
    },
    async (request, reply) =>
      renameMunicipality(
        pool,
        await actor(request, reply),
        request.params.tenantId,
        request.body,
        request.id,
      ),
  );

  app.put<{
    Params: { tenantId: string; variant: LogoVariant };
    Body: { expectedVersion: number; image: string };
  }>(
    "/api/municipalities/:tenantId/branding/logos/:variant",
    {
      // The image travels in base64 inside JSON: up to 2 MiB of file.
      bodyLimit: Math.ceil((logoMaximumBytes * 4) / 3) + 16 * 1024,
      schema: {
        operationId: "saveMunicipalLogo",
        tags: ["Identity"],
        security: [{ quendaSession: [] }],
        description:
          "Administrador municipal con MFA reciente. image es un PNG, JPEG o WebP en base64 de hasta 2 MiB, de al menos 32 px por lado y proporción no mayor de 4:1. No se admiten SVG ni otros formatos. El servidor guarda solo su propia versión WebP, sin metadatos y de hasta 512 px. dark exige que exista el logo principal. Control de versión y auditoría.",
        params: logoParams,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["expectedVersion", "image"],
          properties: {
            expectedVersion: version,
            image: {
              type: "string",
              minLength: 16,
              maxLength: Math.ceil((logoMaximumBytes * 4) / 3) + 4,
            },
          },
        },
        response: branding,
      },
    },
    async (request, reply) =>
      saveLogo(
        pool,
        await actor(request, reply),
        request.params.tenantId,
        request.params.variant,
        request.body,
        request.id,
      ),
  );

  app.delete<{
    Params: { tenantId: string; variant: LogoVariant };
    Querystring: { expectedVersion: string };
  }>(
    "/api/municipalities/:tenantId/branding/logos/:variant",
    {
      schema: {
        operationId: "removeMunicipalLogo",
        tags: ["Identity"],
        security: [{ quendaSession: [] }],
        description:
          "Administrador municipal con MFA reciente. Quita un logo; quitar el principal quita también su versión oscura. Control de versión y auditoría.",
        params: logoParams,
        querystring: {
          type: "object",
          additionalProperties: false,
          required: ["expectedVersion"],
          properties: {
            expectedVersion: { type: "string", pattern: "^[1-9][0-9]{0,9}$" },
          },
        },
        response: branding,
      },
    },
    async (request, reply) =>
      removeLogo(
        pool,
        await actor(request, reply),
        request.params.tenantId,
        request.params.variant,
        Number(request.query.expectedVersion),
        request.id,
      ),
  );
}
