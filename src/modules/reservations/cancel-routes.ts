import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import {
  type AuthConfiguration,
  type Authentication,
  createRequestActor,
} from "../identity/index.ts";
import { acceptanceProperties } from "./acceptance.ts";
import { type CancelReservationInput, cancelReservation } from "./cancel.ts";

export async function registerCancellationRoute(
  app: FastifyInstance,
  pool: Pool,
  auth: Authentication,
  config: AuthConfiguration,
  retentionSeconds: number,
) {
  const actor = createRequestActor(pool, auth, config);
  const uuid = { type: "string", format: "uuid" };
  const instant = { type: "string", format: "date-time" };
  app.post<{
    Params: { tenantId: string; reservationId: string };
    Headers: { "idempotency-key": string };
    Body: CancelReservationInput;
  }>(
    "/api/municipalities/:tenantId/reservations/:reservationId/cancel",
    {
      schema: {
        operationId: "cancelReservation",
        tags: ["Reservations"],
        security: [{ quendaSession: [] }],
        description: `Cancela una reserva propia antes del plazo aceptado. administrative=true exige RESERVATION_MANAGE, MFA reciente y motivo; solo permite omitir el plazo, nunca cancelar tras el inicio. Una reserva ya cancelada no repite efectos. Autorización e idempotencia preceden a expectedRevision. Retención: ${retentionSeconds} segundos.`,
        params: {
          type: "object",
          additionalProperties: false,
          required: ["tenantId", "reservationId"],
          properties: { tenantId: uuid, reservationId: uuid },
        },
        headers: {
          type: "object",
          required: ["idempotency-key"],
          properties: {
            "idempotency-key": {
              type: "string",
              pattern: "^[A-Za-z0-9._:-]{1,200}$",
            },
          },
        },
        body: {
          examples: [{ expectedRevision: 2 }],
          type: "object",
          additionalProperties: false,
          required: ["expectedRevision"],
          properties: {
            expectedRevision: { type: "integer", minimum: 1 },
            administrative: { type: "boolean" },
            reason: { type: "string", minLength: 1, maxLength: 500 },
          },
        },
        response: {
          ...Object.fromEntries(
            [400, 401, 403, 404, 409, 429, 500, 503].map((s) => [
              s,
              { $ref: "ErrorResponse#" },
            ]),
          ),
          200: {
            type: "object",
            additionalProperties: false,
            headers: {
              "idempotency-replayed": {
                type: "string",
                enum: ["true", "false"],
              },
              "idempotency-expires-at": instant,
              "idempotency-retention-seconds": { type: "integer" },
            },
            required: [
              "id",
              "tenantId",
              "unitId",
              "startsAt",
              "endsAt",
              "status",
              "revision",
              "calendarVersion",
              "cancellationMinutes",
              "timeZone",
              ...Object.keys(acceptanceProperties),
            ],
            properties: {
              id: uuid,
              tenantId: uuid,
              unitId: uuid,
              startsAt: instant,
              endsAt: instant,
              status: { type: "string", enum: ["CANCELADA"] },
              revision: { type: "integer", minimum: 1 },
              calendarVersion: { type: "integer", minimum: 1 },
              cancellationMinutes: { type: "integer", minimum: 0 },
              timeZone: { type: "string" },
              ...acceptanceProperties,
            },
          },
        },
      },
    },
    async (request, reply) => {
      const result = await cancelReservation(
        pool,
        await actor(request, reply),
        request.params.tenantId,
        request.params.reservationId,
        request.headers["idempotency-key"],
        request.body,
        request.id,
        retentionSeconds,
      );
      return reply
        .header("idempotency-replayed", String(result.replayed))
        .header("idempotency-expires-at", result.expiresAt)
        .header("idempotency-retention-seconds", String(retentionSeconds))
        .send(result.result);
    },
  );
}
