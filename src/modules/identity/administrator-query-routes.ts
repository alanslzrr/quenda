import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { accountLabelSchema } from "./account-labels.ts";
import {
  listMunicipalAdministratorInvitations,
  listMunicipalAdministrators,
} from "./administrator-query.ts";
import type { AuthConfiguration, Authentication } from "./auth.ts";
import { createRequestActor } from "./request-actor.ts";

const uuid = { type: "string", format: "uuid" } as const;
const accountId = { type: "string", minLength: 1, maxLength: 128 } as const;
const instant = { type: "string", format: "date-time" } as const;
const nullableInstant = { ...instant, nullable: true } as const;

export async function registerAdministratorQueryRoutes(
  app: FastifyInstance,
  pool: Pool,
  auth: Authentication,
  config: AuthConfiguration,
) {
  const actor = createRequestActor(pool, auth, config);
  const queries = [
    {
      path: "administrators",
      operationId: "listMunicipalAdministrators",
      cursor: accountId,
      description:
        "Administrador con MFA reciente: consulta la última asignación administrativa de cada cuenta del municipio, incluida su vigencia actual. No contiene roles de otros municipios.",
      properties: {
        accountId,
        accountLabel: accountLabelSchema,
        invitationId: uuid,
        grantedAt: instant,
        expiresAt: nullableInstant,
        revokedAt: nullableInstant,
        active: { type: "boolean" },
      },
      run: listMunicipalAdministrators,
    },
    {
      path: "administrator-invitations",
      operationId: "listMunicipalAdministratorInvitations",
      cursor: uuid,
      description:
        "Administrador con MFA reciente: consulta el historial de invitaciones del municipio. Una aceptación histórica no acredita un rol vigente; consultar administrators para la asignación actual.",
      properties: {
        invitationId: uuid,
        accountId,
        accountLabel: accountLabelSchema,
        invitedBy: accountId,
        invitedByLabel: accountLabelSchema,
        expiresAt: instant,
        roleExpiresAt: nullableInstant,
        acceptedAt: nullableInstant,
        revokedAt: nullableInstant,
      },
      run: listMunicipalAdministratorInvitations,
    },
  ];
  for (const query of queries) {
    app.get<{ Params: { tenantId: string }; Querystring: { after?: string } }>(
      `/api/municipalities/:tenantId/${query.path}`,
      {
        schema: {
          operationId: query.operationId,
          description: query.description,
          tags: ["Identity"],
          security: [{ quendaSession: [] }],
          params: {
            type: "object",
            additionalProperties: false,
            required: ["tenantId"],
            properties: { tenantId: uuid },
          },
          querystring: {
            type: "object",
            additionalProperties: false,
            properties: { after: query.cursor },
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
                nextCursor: { ...query.cursor, nullable: true },
                items: {
                  type: "array",
                  maxItems: 20,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: Object.keys(query.properties),
                    properties: query.properties,
                  },
                },
              },
            },
          },
        },
      },
      async (request, reply) => {
        reply.header("cache-control", "no-store");
        return query.run(
          pool,
          await actor(request, reply),
          request.params.tenantId,
          request.query.after ?? null,
        );
      },
    );
  }
}
