import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import {
  type AuthConfiguration,
  type Authentication,
  createRequestActor,
} from "../identity/index.ts";
import { type ModifyReservationInput, modifyReservation } from "./modify.ts";

export async function registerModificationRoute(
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
    Body: ModifyReservationInput;
  }>(
    "/api/municipalities/:tenantId/reservations/:reservationId/modify",
    {
      schema: {
        operationId: "modifyReservation",
        tags: ["Reservations"],
        security: [{ quendaSession: [] }],
        description: `Modifica unidad e intervalo dentro del mismo municipio, sin cambiar titular. Exige expectedRevision, plazo de origen y reglas vigentes del destino. administrative=true requiere permiso sobre origen y destino, MFA reciente y motivo; nunca permite cambios tras el inicio. Una petición sin cambios no genera evento. Retención idempotente: ${retentionSeconds} segundos.`,
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
          examples: [
            {
              expectedRevision: 1,
              unitId: "00000000-0000-4000-8000-000000000001",
              startsAt: "2030-01-02T11:00:00Z",
              endsAt: "2030-01-02T12:00:00Z",
            },
          ],
          type: "object",
          additionalProperties: false,
          required: ["expectedRevision", "unitId", "startsAt", "endsAt"],
          properties: {
            unitId: uuid,
            startsAt: instant,
            endsAt: instant,
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
            ],
            properties: {
              id: uuid,
              tenantId: uuid,
              unitId: uuid,
              startsAt: instant,
              endsAt: instant,
              status: { type: "string", enum: ["CONFIRMADA"] },
              revision: { type: "integer", minimum: 1 },
              calendarVersion: { type: "integer", minimum: 1 },
              cancellationMinutes: { type: "integer", minimum: 0 },
              timeZone: { type: "string" },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const result = await modifyReservation(
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
