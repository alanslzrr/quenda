import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { AuthConfiguration, Authentication } from "./auth.ts";
import {
  inviteAdministrator,
  listOwnAdministratorInvitations,
  revokeAdministrator,
  revokeAdministratorInvitation,
} from "./invitations.ts";
import { registerManagerRoutes } from "./manager-routes.ts";
import {
  acceptAdministratorInvitation,
  createMunicipality,
  type MunicipalityInput,
  replaceInitialAdministratorInvitation,
} from "./municipality.ts";
import { createRequestActor } from "./request-actor.ts";

const uuid = { type: "string", format: "uuid" } as const;
const errors = Object.fromEntries(
  [400, 401, 403, 404, 409, 429, 500, 503].map((status) => [
    status,
    { $ref: "ErrorResponse#" },
  ]),
);

export async function registerMunicipalIdentity(
  app: FastifyInstance,
  pool: Pool,
  auth: Authentication,
  config: AuthConfiguration,
) {
  const actor = createRequestActor(pool, auth, config);
  await registerManagerRoutes(app, pool, auth, config);
  app.post<{ Body: MunicipalityInput }>(
    "/api/municipalities",
    {
      schema: {
        operationId: "createMunicipality",
        tags: ["Identity"],
        security: [{ quendaSession: [] }],
        description:
          "Operador con MFA verificado en los últimos cinco minutos: crea el municipio e invita a una cuenta existente como primer administrador. Origin debe coincidir con AUTH_ORIGIN.",
        body: {
          type: "object",
          additionalProperties: false,
          required: [
            "name",
            "timezone",
            "administratorId",
            "invitationExpiresAt",
          ],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 200 },
            timezone: { type: "string", minLength: 1, maxLength: 100 },
            administratorId: { type: "string", minLength: 1, maxLength: 128 },
            invitationExpiresAt: { type: "string", format: "date-time" },
          },
        },
        response: {
          ...errors,
          201: {
            type: "object",
            additionalProperties: false,
            required: ["tenantId", "invitationId"],
            properties: { tenantId: uuid, invitationId: uuid },
          },
        },
      },
    },
    async (request, reply) => {
      const account = await actor(request, reply);
      return reply
        .code(201)
        .send(await createMunicipality(pool, account, request.body));
    },
  );
  app.post<{
    Params: { tenantId: string; invitationId: string };
    Body: Record<string, never>;
  }>(
    "/api/municipalities/:tenantId/administrator-invitations/:invitationId/accept",
    {
      schema: {
        operationId: "acceptAdministratorInvitation",
        tags: ["Identity"],
        security: [{ quendaSession: [] }],
        description:
          "Acepta una invitación vigente de la cuenta autenticada con MFA verificado en los últimos cinco minutos. No admite una cuenta ni un rol alternativo en el cuerpo. Origin debe coincidir con AUTH_ORIGIN.",
        params: {
          type: "object",
          additionalProperties: false,
          required: ["tenantId", "invitationId"],
          properties: { tenantId: uuid, invitationId: uuid },
        },
        body: { type: "object", additionalProperties: false, maxProperties: 0 },
        response: {
          ...errors,
          200: {
            type: "object",
            additionalProperties: false,
            required: ["tenantId"],
            properties: { tenantId: uuid },
          },
        },
      },
    },
    async (request, reply) =>
      acceptAdministratorInvitation(
        pool,
        await actor(request, reply),
        request.params.tenantId,
        request.params.invitationId,
      ),
  );
  app.post<{
    Params: { tenantId: string };
    Body: {
      accountId: string;
      expiresAt: string;
      roleExpiresAt?: string | null;
    };
  }>(
    "/api/municipalities/:tenantId/administrator-invitations",
    {
      schema: {
        operationId: "inviteAdministrator",
        tags: ["Identity"],
        security: [{ quendaSession: [] }],
        description:
          "Administrador municipal con MFA reciente: invita a una cuenta existente, sin conceder permisos hasta su aceptación.",
        params: {
          type: "object",
          additionalProperties: false,
          required: ["tenantId"],
          properties: { tenantId: uuid },
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["accountId", "expiresAt"],
          properties: {
            accountId: { type: "string", minLength: 1, maxLength: 128 },
            expiresAt: { type: "string", format: "date-time" },
            roleExpiresAt: {
              type: "string",
              format: "date-time",
              nullable: true,
            },
          },
        },
        response: {
          ...errors,
          201: {
            type: "object",
            additionalProperties: false,
            required: ["tenantId", "invitationId"],
            properties: { tenantId: uuid, invitationId: uuid },
          },
        },
      },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(
          await inviteAdministrator(
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
    "/api/municipalities/:tenantId/administrator-invitations/:invitationId/revoke",
    {
      schema: {
        operationId: "revokeAdministratorInvitation",
        tags: ["Identity"],
        security: [{ quendaSession: [] }],
        description:
          "Administrador municipal con MFA reciente: revoca una invitación no aceptada de su municipio.",
        params: {
          type: "object",
          additionalProperties: false,
          required: ["tenantId", "invitationId"],
          properties: { tenantId: uuid, invitationId: uuid },
        },
        body: { type: "object", additionalProperties: false, maxProperties: 0 },
        response: {
          ...errors,
          200: {
            type: "object",
            additionalProperties: false,
            required: ["tenantId", "invitationId"],
            properties: { tenantId: uuid, invitationId: uuid },
          },
        },
      },
    },
    async (request, reply) =>
      revokeAdministratorInvitation(
        pool,
        await actor(request, reply),
        request.params.tenantId,
        request.params.invitationId,
      ),
  );
  app.post<{
    Params: { tenantId: string; accountId: string };
    Body: { reason: string };
  }>(
    "/api/municipalities/:tenantId/administrators/:accountId/revoke",
    {
      schema: {
        operationId: "revokeAdministrator",
        tags: ["Identity"],
        security: [{ quendaSession: [] }],
        description:
          "Administrador con MFA reciente: revoca un rol de su municipio con motivo e invalida las invitaciones pendientes emitidas por ese rol.",
        params: {
          type: "object",
          additionalProperties: false,
          required: ["tenantId", "accountId"],
          properties: {
            tenantId: uuid,
            accountId: { type: "string", minLength: 1, maxLength: 128 },
          },
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["reason"],
          properties: {
            reason: { type: "string", minLength: 1, maxLength: 500 },
          },
        },
        response: {
          ...errors,
          200: {
            type: "object",
            additionalProperties: false,
            required: ["tenantId", "accountId"],
            properties: { tenantId: uuid, accountId: { type: "string" } },
          },
        },
      },
    },
    async (request, reply) =>
      revokeAdministrator(
        pool,
        await actor(request, reply),
        request.params.tenantId,
        request.params.accountId,
        request.body.reason,
      ),
  );
  app.get<{ Querystring: { after?: string } }>(
    "/api/me/administrator-invitations",
    {
      schema: {
        operationId: "listOwnAdministratorInvitations",
        tags: ["Identity"],
        security: [{ quendaSession: [] }],
        description:
          "Invitaciones de la cuenta autenticada en cualquier municipio de esta instancia. Páginas de hasta 20 elementos; no permite consultar otro titular.",
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
              nextCursor: { type: "string", format: "uuid", nullable: true },
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
                    status: {
                      type: "string",
                      enum: ["PENDING", "ACCEPTED", "REVOKED", "EXPIRED"],
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
      listOwnAdministratorInvitations(
        pool,
        await actor(request, reply),
        request.query.after ?? null,
      ),
  );
  app.post<{
    Params: { tenantId: string };
    Body: { accountId: string; expiresAt: string; reason: string };
  }>(
    "/api/municipalities/:tenantId/initial-administrator-invitation/replace",
    {
      schema: {
        operationId: "replaceInitialAdministratorInvitation",
        tags: ["Identity"],
        security: [{ quendaSession: [] }],
        description:
          "Operador con MFA reciente: sustituye con motivo la invitación inicial únicamente antes de que el municipio haya tenido un administrador.",
        params: {
          type: "object",
          additionalProperties: false,
          required: ["tenantId"],
          properties: { tenantId: uuid },
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["accountId", "expiresAt", "reason"],
          properties: {
            accountId: { type: "string", minLength: 1, maxLength: 128 },
            expiresAt: { type: "string", format: "date-time" },
            reason: { type: "string", minLength: 1, maxLength: 500 },
          },
        },
        response: {
          ...errors,
          201: {
            type: "object",
            additionalProperties: false,
            required: ["tenantId", "invitationId"],
            properties: { tenantId: uuid, invitationId: uuid },
          },
        },
      },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(
          await replaceInitialAdministratorInvitation(
            pool,
            await actor(request, reply),
            request.params.tenantId,
            request.body,
          ),
        ),
  );
}
