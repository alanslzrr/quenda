import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { accountLabelSchema } from "./account-labels.ts";
import type { AuthConfiguration, Authentication } from "./auth.ts";
import { listMunicipalProfiles } from "./profiles.ts";
import { createRequestActor } from "./request-actor.ts";

export async function registerProfileRoutes(
  app: FastifyInstance,
  pool: Pool,
  auth: Authentication,
  config: AuthConfiguration,
) {
  const actor = createRequestActor(pool, auth, config);
  app.get<{ Params: { tenantId: string }; Querystring: { after?: string } }>(
    "/api/municipalities/:tenantId/profiles",
    {
      schema: {
        operationId: "listMunicipalProfiles",
        tags: ["Identity"],
        security: [{ quendaSession: [] }],
        description:
          "Administrador municipal con MFA reciente: consulta los perfiles de su municipio, con nombre y correo de presentación, sin credenciales ni roles de otros municipios. Hasta veinte elementos por página.",
        params: {
          type: "object",
          additionalProperties: false,
          required: ["tenantId"],
          properties: { tenantId: { type: "string", format: "uuid" } },
        },
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            after: { type: "string", minLength: 1, maxLength: 128 },
          },
        },
        response: {
          ...Object.fromEntries(
            [400, 401, 403, 429, 500, 503].map((status) => [
              status,
              { $ref: "ErrorResponse#" },
            ]),
          ),
          200: {
            type: "object",
            additionalProperties: false,
            required: ["items", "nextCursor"],
            properties: {
              items: {
                type: "array",
                maxItems: 20,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["accountId", "createdAt"],
                  properties: {
                    accountId: { type: "string" },
                    accountLabel: accountLabelSchema,
                    createdAt: { type: "string", format: "date-time" },
                  },
                },
              },
              nextCursor: { type: "string", nullable: true },
            },
          },
        },
      },
    },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      return listMunicipalProfiles(
        pool,
        await actor(request, reply),
        request.params.tenantId,
        request.query.after ?? null,
      );
    },
  );
}
