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
  app.post<{ Body: { confirm: true } }>(
    "/api/me/deactivation",
    {
      schema: {
        operationId: "deactivateAccount",
        tags: ["Identity"],
        security: [{ quendaSession: [] }],
        description:
          "Baja lógica de la cuenta autenticada. Requiere confirmación expresa y Origin autorizado. Rechaza reservas CONFIRMADA con inicio futuro en cualquier municipio de esta instancia y la baja del último operador activo o administrador activo de un municipio. Revoca todas las sesiones y bloquea nuevas operaciones; conserva identidad, reservas y auditoría. No elimina datos, transfiere responsabilidades ni reactiva cuentas.",
        body: {
          type: "object",
          additionalProperties: false,
          required: ["confirm"],
          properties: { confirm: { type: "boolean", enum: [true] } },
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
      const result = await deactivateAccount(pool, account, request.id);
      return reply.header("cache-control", "no-store").send(result);
    },
  );
}
