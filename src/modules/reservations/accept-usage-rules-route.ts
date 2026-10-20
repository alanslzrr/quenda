import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import {
  type AuthConfiguration,
  type Authentication,
  createRequestActor,
} from "../identity/index.ts";
import {
  type AcceptUsageRulesInput,
  acceptReservationUsageRules,
} from "./accept-usage-rules.ts";
import { acceptanceProperties } from "./acceptance.ts";

export async function registerUsageRulesAcceptanceRoute(
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
    Body: AcceptUsageRulesInput;
  }>(
    "/api/municipalities/:tenantId/reservations/:reservationId/accept-usage-rules",
    {
      schema: {
        operationId: "acceptReservationUsageRules",
        tags: ["Reservations"],
        security: [{ quendaSession: [] }],
        description: `El titular acepta expresamente la unidad y versión exactas pendientes tras una reubicación. Exige expectedRevision y un instante anterior al inicio, incluso dentro del plazo restringido de cancelación. No cambia horario, ocupación, cuota, estado ni condiciones de cancelación. No permite al gestor aceptar por el titular. Una versión o unidad distinta devuelve CONDITIONS_CHANGED; una revisión obsoleta, CONFLICT. Una referencia ya aceptada es una operación sin efectos. Retención idempotente: ${retentionSeconds} segundos. Requiere Origin autorizado.`,
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
          type: "object",
          additionalProperties: false,
          required: ["expectedRevision", "unitId", "usageRulesVersion"],
          properties: {
            expectedRevision: { type: "integer", minimum: 1 },
            unitId: uuid,
            usageRulesVersion: {
              type: "integer",
              minimum: 1,
              maximum: 2147483647,
            },
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
              status: { type: "string", enum: ["CONFIRMADA"] },
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
      const result = await acceptReservationUsageRules(
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
        .header("cache-control", "no-store")
        .header("idempotency-replayed", String(result.replayed))
        .header("idempotency-expires-at", result.expiresAt)
        .header("idempotency-retention-seconds", String(retentionSeconds))
        .send(result.result);
    },
  );
}
