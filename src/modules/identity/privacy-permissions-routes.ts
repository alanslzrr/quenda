import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { AuthConfiguration, Authentication } from "./auth.ts";
import {
  acceptGlobalPrivacy,
  type GlobalPrivacyInvitationInput,
  inviteGlobalPrivacy,
  listGlobalPrivacyInvitations,
  privacyOperations,
  revokeGlobalPrivacy,
} from "./privacy-permissions.ts";
import { createRequestActor } from "./request-actor.ts";

const uuid = { type: "string", format: "uuid" } as const;
const accountId = { type: "string", minLength: 1, maxLength: 128 } as const;
const reason = { type: "string", minLength: 1, maxLength: 500 } as const;
const permissions = {
  type: "array",
  minItems: 1,
  maxItems: 2,
  uniqueItems: true,
  items: { type: "string", enum: [...privacyOperations] },
} as const;
const errors = Object.fromEntries(
  [400, 401, 403, 404, 429, 500, 503].map((status) => [
    status,
    { $ref: "ErrorResponse#" },
  ]),
);
const security = [{ quendaSession: [] }];
const invitationResult = {
  type: "object",
  additionalProperties: false,
  required: ["invitationId"],
  properties: { invitationId: uuid },
} as const;
const params = {
  type: "object",
  additionalProperties: false,
  required: ["invitationId"],
  properties: { invitationId: uuid },
} as const;

export async function registerPrivacyPermissionRoutes(
  app: FastifyInstance,
  pool: Pool,
  auth: Authentication,
  config: AuthConfiguration,
) {
  const actor = createRequestActor(pool, auth, config);
  app.post<{ Body: GlobalPrivacyInvitationInput }>(
    "/api/platform/privacy-invitations",
    {
      schema: {
        operationId: "inviteGlobalPrivacy",
        tags: ["Identity"],
        security,
        description:
          "Operador con MFA reciente: invita con motivo a recibir permisos explícitos sobre identidad global. No concede acceso municipal ni sustituye la autorización de cada actuación. El destinatario debe aceptar con MFA.",
        body: {
          type: "object",
          additionalProperties: false,
          required: ["accountId", "permissions", "reason", "expiresAt"],
          properties: {
            accountId,
            permissions,
            reason,
            expiresAt: { type: "string", format: "date-time" },
            roleExpiresAt: {
              type: "string",
              format: "date-time",
              nullable: true,
            },
          },
        },
        response: { ...errors, 201: invitationResult },
      },
    },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      return reply
        .code(201)
        .send(
          await inviteGlobalPrivacy(
            pool,
            await actor(request, reply),
            request.body,
          ),
        );
    },
  );
  app.post<{ Params: { invitationId: string }; Body: Record<string, never> }>(
    "/api/platform/privacy-invitations/:invitationId/accept",
    {
      schema: {
        operationId: "acceptGlobalPrivacy",
        tags: ["Identity"],
        security,
        description:
          "El destinatario con MFA reciente acepta los permisos globales exactos de la invitación vigente. Ser operador no concede esos permisos automáticamente.",
        params,
        body: { type: "object", additionalProperties: false, maxProperties: 0 },
        response: { ...errors, 200: invitationResult },
      },
    },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      return acceptGlobalPrivacy(
        pool,
        await actor(request, reply),
        request.params.invitationId,
      );
    },
  );
  app.post<{ Params: { invitationId: string }; Body: { reason: string } }>(
    "/api/platform/privacy-invitations/:invitationId/revoke",
    {
      schema: {
        operationId: "revokeGlobalPrivacy",
        tags: ["Identity"],
        security,
        description:
          "Operador con MFA reciente: revoca con motivo la invitación o los permisos aceptados. No modifica los permisos municipales ni otras concesiones.",
        params,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["reason"],
          properties: { reason },
        },
        response: { ...errors, 200: invitationResult },
      },
    },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      return revokeGlobalPrivacy(
        pool,
        await actor(request, reply),
        request.params.invitationId,
        request.body.reason,
      );
    },
  );
  for (const own of [true, false]) {
    app.get<{ Querystring: { after?: string } }>(
      own ? "/api/me/privacy-invitations" : "/api/platform/privacy-invitations",
      {
        schema: {
          operationId: own
            ? "listOwnPrivacyInvitations"
            : "listGlobalPrivacyInvitations",
          tags: ["Identity"],
          security,
          description: own
            ? "Invitaciones y permisos globales del usuario autenticado. No acepta otro titular como filtro."
            : "Operador con MFA reciente: consulta concesiones explícitas de privacidad global sin acceder al contenido de los datos personales municipales.",
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
                      "permissions",
                      "reason",
                      "expiresAt",
                      "roleExpiresAt",
                      "status",
                      ...(own ? [] : ["accountId", "invitedBy"]),
                    ],
                    properties: {
                      invitationId: uuid,
                      permissions,
                      reason,
                      expiresAt: { type: "string", format: "date-time" },
                      roleExpiresAt: {
                        type: "string",
                        format: "date-time",
                        nullable: true,
                      },
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
                      ...(own ? {} : { accountId, invitedBy: accountId }),
                    },
                  },
                },
              },
            },
          },
        },
      },
      async (request, reply) => {
        reply.header("cache-control", "no-store");
        return listGlobalPrivacyInvitations(
          pool,
          await actor(request, reply),
          own,
          request.query.after ?? null,
        );
      },
    );
  }
}
