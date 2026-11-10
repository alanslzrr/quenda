import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import {
  type AuthConfiguration,
  type Authentication,
  createRequestActor,
} from "../identity/index.ts";
import { recordReservationArrival } from "./arrival.ts";

export async function registerArrivalRoute(
  app: FastifyInstance,
  pool: Pool,
  auth: Authentication,
  config: AuthConfiguration,
) {
  const actor = createRequestActor(pool, auth, config);
  const uuid = { type: "string", format: "uuid" } as const;
  app.post<{ Params: { tenantId: string; reservationId: string } }>(
    "/api/municipalities/:tenantId/reservations/:reservationId/arrival",
    {
      schema: {
        operationId: "recordReservationArrival",
        tags: ["Reservations"],
        security: [{ quendaSession: [] }],
        description:
          "Registra la llegada del titular tras comprobar el código de acceso de la reserva. Exige RESERVATION_READ o RESERVATION_MANAGE sobre la unidad, sesión con MFA y Origin autorizado. Solo para reservas confirmadas, desde 30 minutos antes del inicio hasta el final; fuera de esa ventana o si está cancelada responde 409. Repetirlo devuelve el primer registro con alreadyRecorded=true. No cambia la revisión de la reserva ni genera avisos.",
        params: {
          type: "object",
          additionalProperties: false,
          required: ["tenantId", "reservationId"],
          properties: { tenantId: uuid, reservationId: uuid },
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
            required: ["arrivedAt", "alreadyRecorded"],
            properties: {
              arrivedAt: { type: "string", format: "date-time" },
              alreadyRecorded: { type: "boolean" },
            },
          },
        },
      },
    },
    async (request, reply) =>
      recordReservationArrival(
        pool,
        await actor(request, reply),
        request.params.tenantId,
        request.params.reservationId,
      ),
  );
}
