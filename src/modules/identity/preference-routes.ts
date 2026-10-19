import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { AuthConfiguration, Authentication } from "./auth.ts";
import {
  readAccountPreferences,
  saveAccountPreferences,
} from "./preferences.ts";
import { createRequestActor } from "./request-actor.ts";
export async function registerPreferenceRoutes(
  app: FastifyInstance,
  pool: Pool,
  auth: Authentication,
  config: AuthConfiguration,
) {
  const actor = createRequestActor(pool, auth, config);
  const body = {
    type: "object",
    additionalProperties: false,
    required: ["locale"],
    properties: {
      locale: { type: "string", enum: ["es", "gl", null], nullable: true },
    },
  };
  for (const method of ["GET", "PUT"] as const) {
    app.route<{ Body: { locale: "es" | "gl" | null } }>({
      method,
      url: "/api/me/preferences",
      schema: {
        operationId:
          method === "GET"
            ? "readAccountPreferences"
            : "saveAccountPreferences",
        tags: ["Identity"],
        security: [{ quendaSession: [] }],
        description:
          "Preferencia global de idioma para nuevos avisos de la cuenta autenticada. null utiliza el idioma configurado del worker. Cambiarla no modifica correos ya pendientes. PUT requiere Origin autorizado; no permite elegir otra cuenta.",
        ...(method === "PUT" ? { body } : {}),
        response: {
          ...Object.fromEntries(
            [400, 401, 403, 429, 500, 503].map((status) => [
              status,
              { $ref: "ErrorResponse#" },
            ]),
          ),
          200: body,
        },
      },
      handler: async (request, reply) => {
        const account = await actor(request, reply);
        return reply
          .header("cache-control", "no-store")
          .send(
            method === "GET"
              ? await readAccountPreferences(pool, account)
              : await saveAccountPreferences(
                  pool,
                  account,
                  request.body.locale,
                ),
          );
      },
    });
  }
}
