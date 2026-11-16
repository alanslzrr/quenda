import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { publicRateLimit } from "../../http/public-rate-limit.ts";
import {
  type AppearanceInput,
  publicAppearance,
  saveAppearance,
} from "./appearance.ts";
import type { AuthConfiguration, Authentication } from "./auth.ts";
import { createRequestActor } from "./request-actor.ts";
import { colorKeys, corners, fonts, themes } from "./themes.ts";

const colors = {
  type: "object",
  additionalProperties: false,
  properties: Object.fromEntries(
    colorKeys.map((key) => [
      key,
      { type: "string", pattern: "^#[0-9a-f]{6}$" },
    ]),
  ),
} as const;
export async function registerAppearanceRoutes(
  app: FastifyInstance,
  pool: Pool,
  auth: Authentication,
  config: AuthConfiguration,
) {
  const actor = createRequestActor(pool, auth, config);
  const fields = {
    theme: { type: "string", enum: themes },
    light: colors,
    dark: colors,
    font: { type: "string", enum: fonts },
    corners: { type: "string", enum: corners },
    defaultTheme: { type: "string", enum: ["light", "dark"] },
  };
  const schema = {
    tags: ["Identity"],
    params: {
      type: "object",
      additionalProperties: false,
      required: ["tenantId"],
      properties: { tenantId: { type: "string", format: "uuid" } },
    },
    response: {
      ...Object.fromEntries(
        [400, 401, 403, 404, 409, 429, 500, 503].map((status) => [
          status,
          { $ref: "ErrorResponse#" },
        ]),
      ),
      200: {
        type: "object",
        additionalProperties: false,
        required: ["version", ...Object.keys(fields)],
        properties: { version: { type: "integer", minimum: 1 }, ...fields },
      },
    },
  };
  app.get<{ Params: { tenantId: string } }>(
    "/api/public/municipalities/:tenantId/appearance",
    {
      onRequest: publicRateLimit(pool, config.secret),
      schema: {
        ...schema,
        security: [],
        operationId: "publicMunicipalAppearance",
      },
    },
    (request) => publicAppearance(pool, request.params.tenantId),
  );
  app.put<{ Params: { tenantId: string }; Body: AppearanceInput }>(
    "/api/municipalities/:tenantId/appearance",
    {
      schema: {
        ...schema,
        security: [{ quendaSession: [] }],
        operationId: "saveMunicipalAppearance",
        description:
          "Administrador municipal con MFA reciente. Guarda un tema del catálogo, ajustes opcionales de fondo, texto y acento por modo, tipografía, forma de las esquinas y modo predeterminado, con control de versión y auditoría. Rechaza combinaciones sin contraste suficiente (texto 4,5:1 y acento 3:1 sobre el fondo) y fondos que no correspondan a su modo. No admite CSS libre.",
        body: {
          type: "object",
          additionalProperties: false,
          required: ["expectedVersion", ...Object.keys(fields)],
          properties: {
            expectedVersion: {
              type: "integer",
              minimum: 1,
              maximum: 2147483646,
            },
            ...fields,
          },
        },
      },
    },
    async (request, reply) =>
      saveAppearance(
        pool,
        await actor(request, reply),
        request.params.tenantId,
        request.body,
        request.id,
      ),
  );
}
