import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { publicRateLimit } from "../../http/public-rate-limit.ts";
import { availabilityResponse } from "../catalog/index.ts";
import {
  type AuthConfiguration,
  type Authentication,
  createRequestActor,
} from "../identity/index.ts";
import { ownModificationAvailability } from "./availability.ts";
export async function registerReservationAvailability(
  app: FastifyInstance,
  pool: Pool,
  auth: Authentication,
  config: AuthConfiguration,
  retentionSeconds: number,
) {
  const actor = createRequestActor(pool, auth, config);
  const uuid = { type: "string", format: "uuid" };
  const errors = Object.fromEntries(
    [400, 401, 403, 404, 409, 429, 500, 503].map((status) => [
      status,
      { $ref: "ErrorResponse#" },
    ]),
  );
  app.get(
    "/api/public/reservation-command-policy",
    {
      onRequest: publicRateLimit(pool, config.secret),
      schema: {
        operationId: "reservationCommandPolicy",
        tags: ["Reservations"],
        security: [],
        description:
          "Retención de resultados idempotentes de la instancia. El cliente consulta este valor antes de enviar un comando y no repite resultados inciertos fuera de esa ventana.",
        response: {
          ...errors,
          200: {
            type: "object",
            additionalProperties: false,
            required: ["retentionSeconds", "serverTime"],
            properties: {
              retentionSeconds: { type: "integer", minimum: 1 },
              serverTime: { type: "string", format: "date-time" },
            },
          },
        },
      },
    },
    async (_request, reply) =>
      reply
        .header("cache-control", "no-store")
        .send({ retentionSeconds, serverTime: new Date().toISOString() }),
  );
  app.get<{
    Params: { tenantId: string; reservationId: string };
    Querystring: {
      unitId: string;
      date: string;
      durationMinutes: string;
      administrative?: string;
    };
  }>(
    "/api/municipalities/:tenantId/reservations/:reservationId/availability",
    {
      schema: {
        operationId: "ownModificationAvailability",
        tags: ["Reservations"],
        security: [{ quendaSession: [] }],
        description:
          "Franjas para modificar una reserva propia futura dentro del plazo aceptado. Excluye únicamente su ocupación; conserva bloqueos y otras reservas. Solo admite unidades públicas del mismo municipio. administrative=true exige RESERVATION_MANAGE en origen y destino y MFA reciente; permite consultar antes del inicio sin aplicar el plazo ciudadano. Consultar no modifica ni garantiza disponibilidad al confirmar.",
        params: {
          type: "object",
          additionalProperties: false,
          required: ["tenantId", "reservationId"],
          properties: { tenantId: uuid, reservationId: uuid },
        },
        querystring: {
          type: "object",
          additionalProperties: false,
          required: ["unitId", "date", "durationMinutes"],
          properties: {
            unitId: uuid,
            date: { type: "string", format: "date" },
            administrative: { type: "string", enum: ["true", "false"] },
            durationMinutes: { type: "string", pattern: "^[1-9][0-9]{0,9}$" },
          },
        },
        response: { ...errors, 200: availabilityResponse },
      },
    },
    async (request, reply) =>
      reply
        .header("cache-control", "no-store")
        .send(
          await ownModificationAvailability(
            pool,
            await actor(request, reply),
            request.params.tenantId,
            request.params.reservationId,
            request.query.unitId,
            request.query.date,
            Number(request.query.durationMinutes),
            undefined,
            request.query.administrative === "true",
          ),
        ),
  );
}
