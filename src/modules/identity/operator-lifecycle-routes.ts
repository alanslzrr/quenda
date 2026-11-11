import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { AuthConfiguration, Authentication } from "./auth.ts";
import {
  acceptOperatorInvitation,
  inviteOperator,
  listOperatorInvitations,
  listOperators,
  listOwnOperatorInvitations,
  revokeOperator,
  revokeOperatorInvitation,
} from "./operator-lifecycle.ts";
import { accountNameSchema } from "./platform-account-names.ts";
import { createRequestActor } from "./request-actor.ts";

const uuid = { type: "string", format: "uuid" } as const;
const accountId = { type: "string", minLength: 1, maxLength: 128 } as const;
const errors = Object.fromEntries(
  [400, 401, 403, 404, 409, 429, 500, 503].map((status) => [
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
const accountResult = {
  type: "object",
  additionalProperties: false,
  required: ["accountId"],
  properties: { accountId },
} as const;
const reason = {
  type: "object",
  additionalProperties: false,
  required: ["reason"],
  properties: { reason: { type: "string", minLength: 1, maxLength: 500 } },
} as const;
const invitationParams = {
  type: "object",
  additionalProperties: false,
  required: ["invitationId"],
  properties: { invitationId: uuid },
} as const;

export async function registerOperatorLifecycleRoutes(
  app: FastifyInstance,
  pool: Pool,
  auth: Authentication,
  config: AuthConfiguration,
) {
  const actor = createRequestActor(pool, auth, config);
  app.post<{ Body: { accountId: string; expiresAt: string } }>(
    "/api/platform/operator-invitations",
    {
      schema: {
        operationId: "inviteOperator",
        tags: ["Identity"],
        security,
        description:
          "Operador con MFA reciente: invita a una cuenta activa y verificada. No concede el permiso hasta que el destinatario acepte con MFA. Origin debe coincidir con AUTH_ORIGIN.",
        body: {
          type: "object",
          additionalProperties: false,
          required: ["accountId", "expiresAt"],
          properties: {
            accountId,
            expiresAt: { type: "string", format: "date-time" },
          },
        },
        response: { ...errors, 201: invitationResult },
      },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(
          await inviteOperator(pool, await actor(request, reply), request.body),
        ),
  );
  app.post<{ Params: { invitationId: string }; Body: Record<string, never> }>(
    "/api/platform/operator-invitations/:invitationId/accept",
    {
      schema: {
        operationId: "acceptOperatorInvitation",
        tags: ["Identity"],
        security,
        description:
          "El destinatario acepta su invitación vigente con MFA reciente. El permiso es indefinido. No admite otro titular ni un rol elegido por el cliente.",
        params: invitationParams,
        body: { type: "object", additionalProperties: false, maxProperties: 0 },
        response: { ...errors, 200: accountResult },
      },
    },
    async (request, reply) =>
      acceptOperatorInvitation(
        pool,
        await actor(request, reply),
        request.params.invitationId,
      ),
  );
  app.post<{ Params: { invitationId: string }; Body: { reason: string } }>(
    "/api/platform/operator-invitations/:invitationId/revoke",
    {
      schema: {
        operationId: "revokeOperatorInvitation",
        tags: ["Identity"],
        security,
        description:
          "Operador con MFA reciente: revoca con motivo una invitación no aceptada. La revocación no afecta a concesiones ya aceptadas.",
        params: invitationParams,
        body: reason,
        response: { ...errors, 200: invitationResult },
      },
    },
    async (request, reply) =>
      revokeOperatorInvitation(
        pool,
        await actor(request, reply),
        request.params.invitationId,
        request.body.reason,
      ),
  );
  app.post<{ Params: { accountId: string }; Body: { reason: string } }>(
    "/api/platform/operators/:accountId/revoke",
    {
      schema: {
        operationId: "revokeOperator",
        tags: ["Identity"],
        security,
        description:
          "Operador con MFA reciente: retira un permiso, incluido el propio, con motivo. Requiere otro operador habilitado y anula las invitaciones pendientes emitidas por el permiso retirado.",
        params: {
          type: "object",
          additionalProperties: false,
          required: ["accountId"],
          properties: { accountId },
        },
        body: reason,
        response: { ...errors, 200: accountResult },
      },
    },
    async (request, reply) =>
      revokeOperator(
        pool,
        await actor(request, reply),
        request.params.accountId,
        request.body.reason,
      ),
  );
  for (const own of [true, false]) {
    app.get<{ Querystring: { after?: string } }>(
      own
        ? "/api/me/operator-invitations"
        : "/api/platform/operator-invitations",
      {
        schema: {
          operationId: own
            ? "listOwnOperatorInvitations"
            : "listOperatorInvitations",
          tags: ["Identity"],
          security,
          description: own
            ? "Invitaciones del usuario autenticado. No necesita tener permisos ni MFA configurado para consultar su invitación."
            : "Operador con MFA reciente: consulta invitaciones de plataforma, sin acceder a actividad municipal.",
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
                      "expiresAt",
                      "status",
                      ...(own
                        ? []
                        : [
                            "accountId",
                            "accountName",
                            "invitedBy",
                            "invitedByName",
                          ]),
                    ],
                    properties: {
                      invitationId: uuid,
                      expiresAt: { type: "string", format: "date-time" },
                      status: {
                        type: "string",
                        enum: ["PENDING", "ACCEPTED", "REVOKED", "EXPIRED"],
                      },
                      ...(own
                        ? {}
                        : {
                            accountId,
                            accountName: accountNameSchema,
                            invitedBy: accountId,
                            invitedByName: accountNameSchema,
                          }),
                    },
                  },
                },
              },
            },
          },
        },
      },
      async (request, reply) =>
        (own ? listOwnOperatorInvitations : listOperatorInvitations)(
          pool,
          await actor(request, reply),
          request.query.after ?? null,
        ),
    );
  }
  app.get<{ Querystring: { after?: string } }>(
    "/api/platform/operators",
    {
      schema: {
        operationId: "listOperators",
        tags: ["Identity"],
        security,
        description:
          "Operador con MFA reciente: consulta concesiones y su estado efectivo. Habilitado exige cuenta activa, correo verificado y MFA configurado.",
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { after: accountId },
        },
        response: {
          ...errors,
          200: {
            type: "object",
            additionalProperties: false,
            required: ["items", "nextCursor"],
            properties: {
              nextCursor: { type: "string", nullable: true },
              items: {
                type: "array",
                maxItems: 20,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: [
                    "accountId",
                    "accountName",
                    "grantedAt",
                    "revokedAt",
                    "active",
                  ],
                  properties: {
                    accountId,
                    accountName: accountNameSchema,
                    grantedAt: { type: "string", format: "date-time" },
                    revokedAt: {
                      type: "string",
                      format: "date-time",
                      nullable: true,
                    },
                    active: { type: "boolean" },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) =>
      listOperators(
        pool,
        await actor(request, reply),
        request.query.after ?? null,
      ),
  );
}
