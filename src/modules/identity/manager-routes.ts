import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { AuthConfiguration, Authentication } from "./auth.ts";
import {
  acceptManager,
  inviteManager,
  listOwnManagerInvitations,
  type ManagerInvitationInput,
  operations,
  revokeManager,
} from "./manager.ts";
import { listMunicipalManagerInvitations } from "./manager-query.ts";
import { createRequestActor } from "./request-actor.ts";

const uuid = { type: "string", format: "uuid" } as const;
const response = {
  type: "object",
  additionalProperties: false,
  required: ["tenantId", "invitationId"],
  properties: { tenantId: uuid, invitationId: uuid },
} as const;
const errors = Object.fromEntries(
  [400, 401, 403, 404, 429, 500, 503].map((status) => [
    status,
    { $ref: "ErrorResponse#" },
  ]),
);
export async function registerManagerRoutes(
  app: FastifyInstance,
  pool: Pool,
  auth: Authentication,
  config: AuthConfiguration,
) {
  const actor = createRequestActor(pool, auth, config);
  app.post<{ Params: { tenantId: string }; Body: ManagerInvitationInput }>(
    "/api/municipalities/:tenantId/manager-invitations",
    {
      schema: {
        operationId: "inviteManager",
        tags: ["Identity"],
        security: [{ quendaSession: [] }],
        description:
          "Administrador con MFA reciente: invita con operaciones y unidades explícitas. unitId nulo delimita todo el municipio; CATALOG_CREATE, PRIVACY_READ y PRIVACY_EXECUTE solo admiten ámbito municipal. Los permisos de privacidad requieren concesión explícita incluso para administradores.",
        params: {
          type: "object",
          additionalProperties: false,
          required: ["tenantId"],
          properties: { tenantId: uuid },
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["accountId", "expiresAt", "permissions"],
          properties: {
            accountId: { type: "string", minLength: 1, maxLength: 128 },
            replacesInvitationId: uuid,
            reason: { type: "string", minLength: 1, maxLength: 500 },
            expiresAt: { type: "string", format: "date-time" },
            roleExpiresAt: {
              type: "string",
              format: "date-time",
              nullable: true,
            },
            permissions: {
              type: "array",
              minItems: 1,
              maxItems: 50,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["operation", "unitId"],
                properties: {
                  operation: { type: "string", enum: [...operations] },
                  unitId: { ...uuid, nullable: true },
                },
              },
            },
          },
        },
        response: { ...errors, 201: response },
      },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(
          await inviteManager(
            pool,
            await actor(request, reply),
            request.params.tenantId,
            request.body,
          ),
        ),
  );
  app.post<{
    Params: { tenantId: string; invitationId: string };
    Body: Record<string, never>;
  }>(
    "/api/municipalities/:tenantId/manager-invitations/:invitationId/accept",
    {
      schema: {
        operationId: "acceptManager",
        tags: ["Identity"],
        security: [{ quendaSession: [] }],
        description:
          "El destinatario con MFA reciente acepta exactamente los permisos de la invitación vigente.",
        params: {
          type: "object",
          additionalProperties: false,
          required: ["tenantId", "invitationId"],
          properties: { tenantId: uuid, invitationId: uuid },
        },
        body: { type: "object", additionalProperties: false, maxProperties: 0 },
        response: { ...errors, 200: response },
      },
    },
    async (request, reply) =>
      acceptManager(
        pool,
        await actor(request, reply),
        request.params.tenantId,
        request.params.invitationId,
      ),
  );
  app.post<{
    Params: { tenantId: string; invitationId: string };
    Body: { reason: string };
  }>(
    "/api/municipalities/:tenantId/manager-invitations/:invitationId/revoke",
    {
      schema: {
        operationId: "revokeManager",
        tags: ["Identity"],
        security: [{ quendaSession: [] }],
        description:
          "Administrador con MFA reciente: revoca la invitación pendiente o su concesión aceptada, con motivo auditable.",
        params: {
          type: "object",
          additionalProperties: false,
          required: ["tenantId", "invitationId"],
          properties: { tenantId: uuid, invitationId: uuid },
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["reason"],
          properties: {
            reason: { type: "string", minLength: 1, maxLength: 500 },
          },
        },
        response: { ...errors, 200: response },
      },
    },
    async (request, reply) =>
      revokeManager(
        pool,
        await actor(request, reply),
        request.params.tenantId,
        request.params.invitationId,
        request.body.reason,
      ),
  );
  app.get<{ Querystring: { after?: string } }>(
    "/api/me/manager-invitations",
    {
      schema: {
        operationId: "listOwnManagerInvitations",
        tags: ["Identity"],
        security: [{ quendaSession: [] }],
        description:
          "Invitaciones y concesiones del titular autenticado, con ámbitos y estado actual. Hasta veinte por página; no acepta otra cuenta como filtro.",
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { after: uuid },
        },
        response: {
          ...errors,
          200: {
            type: "object",
            additionalProperties: false,
            required: ["items", "nextCursor"],
            properties: {
              nextCursor: { ...uuid, nullable: true },
              items: {
                type: "array",
                maxItems: 20,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: [
                    "invitationId",
                    "tenantId",
                    "municipality",
                    "expiresAt",
                    "roleExpiresAt",
                    "status",
                    "permissions",
                    "replacesInvitationId",
                  ],
                  properties: {
                    invitationId: uuid,
                    tenantId: uuid,
                    municipality: { type: "string" },
                    expiresAt: { type: "string", format: "date-time" },
                    roleExpiresAt: {
                      type: "string",
                      format: "date-time",
                      nullable: true,
                    },
                    replacesInvitationId: { ...uuid, nullable: true },
                    status: {
                      type: "string",
                      enum: [
                        "PENDING",
                        "ACTIVE",
                        "REVOKED",
                        "EXPIRED",
                        "INVALIDATED",
                      ],
                    },
                    permissions: {
                      type: "array",
                      minItems: 1,
                      maxItems: 50,
                      items: {
                        type: "object",
                        additionalProperties: false,
                        required: ["operation", "unitId"],
                        properties: {
                          operation: { type: "string", enum: [...operations] },
                          unitId: { ...uuid, nullable: true },
                        },
                      },
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
      listOwnManagerInvitations(
        pool,
        await actor(request, reply),
        request.query.after ?? null,
      ),
  );
  app.get<{ Params: { tenantId: string }; Querystring: { after?: string } }>(
    "/api/municipalities/:tenantId/manager-invitations",
    {
      schema: {
        operationId: "listMunicipalManagerInvitations",
        tags: ["Identity"],
        security: [{ quendaSession: [] }],
        description:
          "Administrador con MFA reciente: consulta las invitaciones y concesiones del municipio, incluidos sus ámbitos y fechas de aceptación, vencimiento y revocación. La consulta no concede autoridad; cada operación comprueba permisos vigentes.",
        params: {
          type: "object",
          additionalProperties: false,
          required: ["tenantId"],
          properties: { tenantId: uuid },
        },
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { after: uuid },
        },
        response: {
          ...errors,
          200: {
            type: "object",
            additionalProperties: false,
            required: ["items", "nextCursor"],
            properties: {
              nextCursor: { ...uuid, nullable: true },
              items: {
                type: "array",
                maxItems: 20,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: [
                    "invitationId",
                    "accountId",
                    "invitedBy",
                    "expiresAt",
                    "roleExpiresAt",
                    "acceptedAt",
                    "revokedAt",
                    "replacesInvitationId",
                    "permissions",
                  ],
                  properties: {
                    invitationId: uuid,
                    accountId: { type: "string" },
                    invitedBy: { type: "string" },
                    expiresAt: { type: "string", format: "date-time" },
                    roleExpiresAt: {
                      type: "string",
                      format: "date-time",
                      nullable: true,
                    },
                    acceptedAt: {
                      type: "string",
                      format: "date-time",
                      nullable: true,
                    },
                    revokedAt: {
                      type: "string",
                      format: "date-time",
                      nullable: true,
                    },
                    replacesInvitationId: { ...uuid, nullable: true },
                    permissions: {
                      type: "array",
                      minItems: 1,
                      maxItems: 50,
                      items: {
                        type: "object",
                        additionalProperties: false,
                        required: ["operation", "unitId"],
                        properties: {
                          operation: { type: "string", enum: [...operations] },
                          unitId: { ...uuid, nullable: true },
                        },
                      },
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
      listMunicipalManagerInvitations(
        pool,
        await actor(request, reply),
        request.params.tenantId,
        request.query.after ?? null,
      ),
  );
}
