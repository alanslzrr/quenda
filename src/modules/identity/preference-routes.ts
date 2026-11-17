import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { AuthConfiguration, Authentication } from "./auth.ts";
import {
  readAccountPreferences,
  saveAccountPreferences,
} from "./preferences.ts";
import { createRequestActor } from "./request-actor.ts";
import { accountTheme, type ThemePreference } from "./theme-preferences.ts";
export async function registerPreferenceRoutes(
  app: FastifyInstance,
  pool: Pool,
  auth: Authentication,
  config: AuthConfiguration,
) {
  const actor = createRequestActor(pool, auth, config);
  const themeSchema = {
    type: "object",
    additionalProperties: false,
    required: ["theme"],
    properties: {
      theme: {
        type: "string",
        enum: ["light", "dark", "system", null],
        nullable: true,
      },
    },
  };
  for (const method of ["GET", "PUT"] as const) {
    app.route<{ Body: { theme: ThemePreference } }>({
      method,
      url: "/api/me/theme",
      schema: {
        operationId: method === "GET" ? "readAccountTheme" : "saveAccountTheme",
        tags: ["Identity"],
        security: [{ quendaSession: [] }],
        description:
          "Preferencia personal de modo claro, oscuro o del sistema (system). null utiliza el modo municipal predeterminado o el modo claro de Quenda. No modifica la apariencia municipal ni el idioma.",
        ...(method === "PUT" ? { body: themeSchema } : {}),
        response: {
          ...Object.fromEntries(
            [400, 401, 403, 429, 500, 503].map((status) => [
              status,
              { $ref: "ErrorResponse#" },
            ]),
          ),
          200: themeSchema,
        },
      },
      handler: async (request, reply) =>
        reply
          .header("cache-control", "no-store")
          .send(
            await accountTheme(
              pool,
              await actor(request, reply),
              method === "PUT" ? request.body : undefined,
            ),
          ),
    });
  }
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
