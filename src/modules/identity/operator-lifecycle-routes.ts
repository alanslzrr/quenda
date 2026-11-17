import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { AuthConfiguration, Authentication } from "./auth.ts";
import { invitationAddressSchema } from "./invitation-address.ts";
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
  app.post<{ Body: { email: string; expiresAt: string } }>(
    "/api/platform/operator-invitations",
    {
      schema: {
        operationId: "inviteOperator",
        tags: ["Identity"],
        security,
        description:
          "Operador con MFA reciente: invita a un correo, normalizado, sin buscar cuentas; la respuesta es la misma exista o no una cuenta con él. Rechaza el correo del propio operador y un correo con otra invitación pendiente. Solo puede aceptarla, con MFA reciente, la cuenta cuyo correo verificado coincida al aceptar; no concede el permiso hasta entonces. Origin debe coincidir con AUTH_ORIGIN.",
        body: {
          type: "object",
          additionalProperties: false,
          required: ["email", "expiresAt"],
          properties: {
            email: invitationAddressSchema,
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
          "El destinatario acepta su invitación vigente con MFA reciente: la cuenta cuyo correo verificado coincide con el de la invitación en ese momento, o la cuenta a la que se dirigía una invitación anterior a las invitaciones por correo. El permiso es indefinido. No admite otro titular ni un rol elegido por el cliente.",
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
            ? "Invitaciones del usuario autenticado: las dirigidas a su correo verificado actual y las anteriores dirigidas a su cuenta. No necesita tener permisos ni MFA configurado para consultar su invitación."
            : "Operador con MFA reciente: consulta invitaciones de plataforma, sin acceder a actividad municipal. recipientEmail es el correo de una invitación sin aceptar; accountId, la cuenta que la aceptó o a la que se dirigía una invitación anterior. Ambos son nulos cuando la conservación ya retiró el correo.",
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
                            "recipientEmail",
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
                            accountId: { ...accountId, nullable: true },
                            recipientEmail: {
                              ...invitationAddressSchema,
                              nullable: true,
                            },
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
