import { createHash } from "node:crypto";
import { fromNodeHeaders } from "better-auth/node";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { AuthConfiguration, Authentication } from "./auth.ts";
import { deactivateAccount } from "./deactivation.ts";
import { createRequestActor } from "./request-actor.ts";

export async function registerDeactivationRoutes(
  app: FastifyInstance,
  pool: Pool,
  auth: Authentication,
  config: AuthConfiguration,
) {
  const actor = createRequestActor(pool, auth, config);
  app.post<{ Body: { confirm: true; password: string } }>(
    "/api/me/deactivation",
    {
      schema: {
        operationId: "deactivateAccount",
        tags: ["Identity"],
        security: [{ quendaSession: [] }],
        description:
          "Baja lógica de la cuenta autenticada. Requiere confirmación expresa, contraseña actual, Origin autorizado y MFA verificado durante los últimos cinco minutos si está habilitado. Rechaza reservas CONFIRMADA futuras o en curso en cualquier municipio y exige conservar un responsable habilitado sin caducidad. Revoca todas las sesiones, permisos e invitaciones pendientes; conserva identidad, reservas y auditoría. No elimina datos ni transfiere responsabilidades.",
        body: {
          type: "object",
          additionalProperties: false,
          required: ["confirm", "password"],
          properties: {
            confirm: { type: "boolean", enum: [true] },
            password: { type: "string", minLength: 1, maxLength: 128 },
          },
        },
        response: {
          ...Object.fromEntries(
            [400, 401, 403, 409, 429, 500, 503].map((status) => [
              status,
              { $ref: "ErrorResponse#" },
            ]),
          ),
          200: {
            type: "object",
            additionalProperties: false,
            required: ["status", "deactivatedAt"],
            properties: {
              status: { type: "string", enum: ["DEACTIVATED"] },
              deactivatedAt: { type: "string", format: "date-time" },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const account = await actor(request, reply);
      const proof = await auth.verifyDeactivation(
        fromNodeHeaders(request.headers),
        request.body.password,
      );
      const result = await deactivateAccount(
        pool,
        account,
        request.id,
        createHash("sha256").update(proof).digest("hex"),
      );
      return reply.header("cache-control", "no-store").send(result);
    },
  );
}
