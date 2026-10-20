import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { AuthConfiguration, Authentication } from "./auth.ts";
import { createRequestActor } from "./request-actor.ts";
import { suspendAccount } from "./security.ts";
export async function registerAccountSecurityRoutes(
  app: FastifyInstance,
  pool: Pool,
  auth: Authentication,
  config: AuthConfiguration,
) {
  const actor = createRequestActor(pool, auth, config);
  app.post<{ Params: { accountId: string }; Body: { reason: string } }>(
    "/api/platform/accounts/:accountId/suspend",
    {
      schema: {
        operationId: "suspendAccount",
        tags: ["Identity"],
        security: [{ quendaSession: [] }],
        description:
          "Operador con MFA reciente: suspende la identidad global, revoca sesiones y permisos propios e invalida invitaciones pendientes. No cancela reservas ni borra historial. La recuperación es operativa y verificada; no admite reactivación ciudadana.",
        params: {
          type: "object",
          additionalProperties: false,
          required: ["accountId"],
          properties: {
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
          ...Object.fromEntries(
            [400, 401, 403, 404, 409, 429, 500, 503].map((status) => [
              status,
              { $ref: "ErrorResponse#" },
            ]),
          ),
          200: {
            type: "object",
            additionalProperties: false,
            required: ["accountId", "suspendedAt"],
            properties: {
              accountId: { type: "string" },
              suspendedAt: { type: "string", format: "date-time" },
            },
          },
        },
      },
    },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      return suspendAccount(
        pool,
        await actor(request, reply),
        request.params.accountId,
        request.body.reason,
        request.id,
      );
    },
  );
}
