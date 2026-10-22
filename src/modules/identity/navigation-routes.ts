import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { publicRateLimit } from "../catalog/public-limit.ts";
import type { AuthConfiguration, Authentication } from "./auth.ts";
import { operations } from "./manager.ts";
import { accountNavigation, publicMunicipalities } from "./navigation.ts";
import { createRequestActor } from "./request-actor.ts";

const uuid = { type: "string", format: "uuid" } as const;
const querystring = {
  type: "object",
  additionalProperties: false,
  properties: { after: uuid },
};
const municipality = {
  type: "object",
  additionalProperties: false,
  required: ["id", "name", "timeZone"],
  properties: {
    id: uuid,
    name: { type: "string" },
    timeZone: { type: "string" },
  },
};
const page = (items: object) => ({
  type: "object",
  additionalProperties: false,
  required: ["items", "nextCursor"],
  properties: {
    items: { type: "array", maxItems: 20, items },
    nextCursor: { ...uuid, nullable: true },
  },
});
const errors = Object.fromEntries(
  [400, 401, 403, 404, 429, 500, 503].map((status) => [
    status,
    { $ref: "ErrorResponse#" },
  ]),
);
export async function registerNavigationRoutes(
  app: FastifyInstance,
  pool: Pool,
  auth: Authentication,
  config: AuthConfiguration,
) {
  const actor = createRequestActor(pool, auth, config);
  const limit = publicRateLimit(pool, config.secret);
  app.get<{ Querystring: { after?: string } }>(
    "/api/public/municipalities",
    {
      onRequest: limit,
      schema: {
        operationId: "publicMunicipalities",
        tags: ["Public catalog"],
        security: [],
        querystring,
        response: { ...errors, 200: page(municipality) },
      },
    },
    (request) => publicMunicipalities(pool, request.query.after ?? null),
  );
  app.get<{ Params: { tenantId: string } }>(
    "/api/public/municipalities/:tenantId",
    {
      onRequest: limit,
      schema: {
        operationId: "publicMunicipality",
        tags: ["Public catalog"],
        security: [],
        params: {
          type: "object",
          additionalProperties: false,
          required: ["tenantId"],
          properties: { tenantId: uuid },
        },
        response: { ...errors, 200: municipality },
      },
    },
    async (request) =>
      (await publicMunicipalities(pool, null, request.params.tenantId))
        .items[0],
  );
  app.get<{ Querystring: { after?: string } }>(
    "/api/me/navigation",
    {
      schema: {
        operationId: "accountNavigation",
        description:
          "Ámbitos y permisos propios para navegación. No sustituye la autorización de cada operación ni acredita MFA reciente.",
        tags: ["Identity"],
        security: [{ quendaSession: [] }],
        querystring,
        response: {
          ...errors,
          200: {
            type: "object",
            additionalProperties: false,
            required: ["municipalities", "platform"],
            properties: {
              municipalities: page({
                type: "object",
                additionalProperties: false,
                required: ["id", "name", "administrator", "permissions"],
                properties: {
                  id: uuid,
                  name: { type: "string" },
                  administrator: { type: "boolean" },
                  permissions: {
                    type: "array",
                    items: {
                      type: "object",
                      additionalProperties: false,
                      required: ["operation", "unitId"],
                      properties: {
                        operation: { type: "string", enum: operations },
                        unitId: { ...uuid, nullable: true },
                      },
                    },
                  },
                },
              }),
              platform: {
                type: "object",
                additionalProperties: false,
                required: ["operator", "permissions"],
                properties: {
                  operator: { type: "boolean" },
                  permissions: {
                    type: "array",
                    items: {
                      type: "string",
                      enum: ["PRIVACY_READ", "PRIVACY_EXECUTE"],
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) =>
      reply
        .header("cache-control", "no-store")
        .send(
          await accountNavigation(
            pool,
            await actor(request, reply),
            request.query.after ?? null,
          ),
        ),
  );
}
