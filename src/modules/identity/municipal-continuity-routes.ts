import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { AuthConfiguration, Authentication } from "./auth.ts";
import { invitationAddressSchema } from "./invitation-address.ts";
import {
  makeAdministratorIndefinite,
  recoverMunicipalAdministrator,
  revokeAddressInvitationsForSecurity,
  revokeMunicipalAccessForSecurity,
} from "./municipal-continuity.ts";
import { createRequestActor } from "./request-actor.ts";

const uuid = { type: "string", format: "uuid" } as const;
const accountId = { type: "string", minLength: 1, maxLength: 128 } as const;
const reason = { type: "string", minLength: 1, maxLength: 500 } as const;
const errors = Object.fromEntries(
  [400, 401, 403, 404, 409, 429, 500, 503].map((status) => [
    status,
    { $ref: "ErrorResponse#" },
  ]),
);

export async function registerMunicipalContinuityRoutes(
  app: FastifyInstance,
  pool: Pool,
  auth: Authentication,
  config: AuthConfiguration,
) {
  const actor = createRequestActor(pool, auth, config);
  for (const route of [
    {
      path: "administrators/:accountId/make-indefinite",
      operationId: "makeAdministratorIndefinite",
      description:
        "Administrador municipal con MFA reciente: convierte un permiso temporal vigente ya aceptado en indefinido, con motivo y auditoría, sin nueva invitación.",
      run: makeAdministratorIndefinite,
    },
    {
      path: "accounts/:accountId/revoke-access-for-security",
      operationId: "revokeMunicipalAccessForSecurity",
      description:
        "Administrador municipal con MFA reciente: retira por seguridad todos los permisos e invitaciones pendientes de la cuenta en este municipio, incluso el último administrador, y entonces también las invitaciones pendientes a su correo verificado. 404 si la cuenta no tenía permisos ni invitaciones propios que retirar, aunque haya invitaciones a su correo: esas se retiran con invitation-addresses/revoke-for-security. No suspende la identidad global ni modifica otros municipios.",
      run: revokeMunicipalAccessForSecurity,
    },
  ]) {
    app.post<{
      Params: { tenantId: string; accountId: string };
      Body: { reason: string };
    }>(
      `/api/municipalities/:tenantId/${route.path}`,
      {
        schema: {
          operationId: route.operationId,
          description: route.description,
          tags: ["Identity"],
          security: [{ quendaSession: [] }],
          params: {
            type: "object",
            additionalProperties: false,
            required: ["tenantId", "accountId"],
            properties: { tenantId: uuid, accountId },
          },
          body: {
            type: "object",
            additionalProperties: false,
            required: ["reason"],
            properties: { reason },
          },
          response: {
            ...errors,
            200: {
              type: "object",
              additionalProperties: false,
              required: ["tenantId", "accountId"],
              properties: { tenantId: uuid, accountId },
            },
          },
        },
      },
      async (request, reply) =>
        route.run(
          pool,
          await actor(request, reply),
          request.params.tenantId,
          request.params.accountId,
          request.body.reason,
        ),
    );
  }
  app.post<{
    Params: { tenantId: string };
    Body: { email: string; reason: string };
  }>(
    "/api/municipalities/:tenantId/invitation-addresses/revoke-for-security",
    {
      schema: {
        operationId: "revokeAddressInvitationsForSecurity",
        description:
          "Administrador municipal con MFA reciente: revoca por seguridad, con motivo, las invitaciones de administrador y gestor de este municipio pendientes y dirigidas a ese correo, que nadie ha aceptado todavía. No busca ninguna cuenta: 404 indica solo que no había invitaciones pendientes a esa dirección. Para una cuenta que ya tiene permisos, usar revoke-access-for-security.",
        tags: ["Identity"],
        security: [{ quendaSession: [] }],
        params: {
          type: "object",
          additionalProperties: false,
          required: ["tenantId"],
          properties: { tenantId: uuid },
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["email", "reason"],
          properties: { email: invitationAddressSchema, reason },
        },
        response: {
          ...errors,
          200: {
            type: "object",
            additionalProperties: false,
            required: ["tenantId", "email"],
            properties: { tenantId: uuid, email: invitationAddressSchema },
          },
        },
      },
    },
    async (request, reply) =>
      revokeAddressInvitationsForSecurity(
        pool,
        await actor(request, reply),
        request.params.tenantId,
        request.body.email,
        request.body.reason,
      ),
  );
  app.post<{
    Params: { tenantId: string };
    Body: {
      email: string;
      expiresAt: string;
      reason: string;
      verificationReference: string;
    };
  }>(
    "/api/municipalities/:tenantId/administrator-recovery-invitations",
    {
      schema: {
        operationId: "recoverMunicipalAdministrator",
        description:
          "Operador con MFA reciente: inicia recuperación únicamente si el municipio ya inicializado no tiene administradores habilitados. Exige motivo y referencia a la verificación externa de autoridad. La invitación se dirige a un correo y la respuesta es la misma exista o no una cuenta con él; solo puede aceptarla, con MFA reciente, la cuenta cuyo correo verificado coincida al aceptar. No concede acceso municipal al operador.",
        tags: ["Identity"],
        security: [{ quendaSession: [] }],
        params: {
          type: "object",
          additionalProperties: false,
          required: ["tenantId"],
          properties: { tenantId: uuid },
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["email", "expiresAt", "reason", "verificationReference"],
          properties: {
            email: invitationAddressSchema,
            expiresAt: { type: "string", format: "date-time" },
            reason,
            verificationReference: reason,
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
          await recoverMunicipalAdministrator(
            pool,
            await actor(request, reply),
            request.params.tenantId,
            request.body,
          ),
        ),
  );
}
