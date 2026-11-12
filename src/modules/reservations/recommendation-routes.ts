import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { type Clock, systemClock } from "../../shared/clock.ts";
import { availabilityResponse } from "../catalog/index.ts";
import {
  type AuthConfiguration,
  type Authentication,
  createRequestActor,
  saveRecommendationPreference,
} from "../identity/index.ts";
import { ownRecommendations } from "./recommendations.ts";

export async function registerRecommendationRoutes(
  app: FastifyInstance,
  pool: Pool,
  auth: Authentication,
  config: AuthConfiguration,
  clock: Clock = systemClock,
) {
  const actor = createRequestActor(pool, auth, config);
  const errors = (statuses: number[]) =>
    Object.fromEntries(
      statuses.map((status) => [status, { $ref: "ErrorResponse#" }]),
    );
  const uuid = { type: "string", format: "uuid" } as const;
  const count = { type: "integer", minimum: 0 } as const;

  app.get(
    "/api/me/recommendations",
    {
      schema: {
        operationId: "readOwnRecommendations",
        tags: ["Reservations"],
        security: [{ quendaSession: [] }],
        description:
          "Recomendaciones de horario para la propia cuenta: hasta tres franjas libres que repiten un hábito del titular (mismo espacio, día de la semana, hora local de inicio y duración, reservados y confirmados al menos dos veces en los últimos 183 días). Se calculan en cada petición con sus reservas, solo para la cuenta y sin guardar ningún perfil; cada franja es la primera libre en los próximos 62 días dentro de la antelación permitida, calculada como la disponibilidad pública y sin garantizar la reserva. Con las recomendaciones desactivadas devuelve enabled false y ninguna lectura de reservas.",
        response: {
          ...errors([401, 403, 429, 500, 503]),
          200: {
            type: "object",
            additionalProperties: false,
            required: ["enabled", "items"],
            properties: {
              enabled: { type: "boolean" },
              items: {
                type: "array",
                maxItems: 3,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: [
                    "tenantId",
                    "municipality",
                    "unitId",
                    "unitName",
                    "facilityName",
                    "weekday",
                    "startMinute",
                    "durationMinutes",
                    "occurrences",
                    "slot",
                  ],
                  properties: {
                    tenantId: uuid,
                    municipality: { type: "string" },
                    unitId: uuid,
                    unitName: { type: "string" },
                    facilityName: { type: "string" },
                    weekday: { type: "integer", minimum: 1, maximum: 7 },
                    startMinute: { type: "integer", minimum: 0, maximum: 1439 },
                    durationMinutes: { type: "integer", minimum: 1 },
                    occurrences: { ...count, minimum: 2 },
                    slot: availabilityResponse.properties.slots.items,
                  },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) =>
      ownRecommendations(pool, await actor(request, reply), clock),
  );

  app.put<{ Body: { enabled: boolean } }>(
    "/api/me/recommendations",
    {
      schema: {
        operationId: "saveRecommendationPreference",
        tags: ["Reservations"],
        security: [{ quendaSession: [] }],
        description:
          "Activa o desactiva las recomendaciones de horario de la cuenta. Desactivarlas evita que se lean las reservas para calcularlas. Requiere Origin autorizado.",
        body: {
          type: "object",
          additionalProperties: false,
          required: ["enabled"],
          properties: { enabled: { type: "boolean" } },
        },
        response: {
          ...errors([400, 401, 403, 429, 500, 503]),
          200: {
            type: "object",
            additionalProperties: false,
            required: ["enabled"],
            properties: { enabled: { type: "boolean" } },
          },
        },
      },
    },
    async (request, reply) =>
      saveRecommendationPreference(
        pool,
        await actor(request, reply),
        request.body.enabled,
      ),
  );
}
