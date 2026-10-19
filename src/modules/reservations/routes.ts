import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import {
  type AuthConfiguration,
  type Authentication,
  createRequestActor,
} from "../identity/index.ts";
import { registerBlockRoutes } from "./block-routes.ts";
import { registerCancellationRoute } from "./cancel-routes.ts";
import { type CreateReservationInput, createReservation } from "./create.ts";
import { registerModificationRoute } from "./modify-routes.ts";

import { registerReservationQueries } from "./query-routes.ts";

const uuid = { type: "string", format: "uuid" } as const;
const instant = { type: "string", format: "date-time" } as const;
export async function registerReservations(
  app: FastifyInstance,
  pool: Pool,
  auth: Authentication,
  config: AuthConfiguration,
  retentionSeconds: number,
) {
  const actor = createRequestActor(pool, auth, config);
  await registerReservationQueries(app, pool, auth, config);
  await registerBlockRoutes(app, pool, auth, config, retentionSeconds);
  await registerModificationRoute(app, pool, auth, config, retentionSeconds);
  await registerCancellationRoute(app, pool, auth, config, retentionSeconds);
  app.post<{
    Params: { tenantId: string };
    Headers: { "idempotency-key": string };
    Body: CreateReservationInput;
  }>(
    "/api/municipalities/:tenantId/reservations",
    {
      schema: {
        operationId: "createReservation",
        tags: ["Reservations"],
        security: [{ quendaSession: [] }],
        description: `Confirma una reserva del usuario autenticado. Idempotency-Key se delimita por usuario, municipio y operación; retención de esta instancia: ${retentionSeconds} segundos. Repetir clave y contenido recupera el resultado original sin duplicar efectos. Contenido distinto o contención prolongada devuelve 409. Requiere Origin autorizado.`,
        params: {
          type: "object",
          additionalProperties: false,
          required: ["tenantId"],
          properties: { tenantId: uuid },
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
          required: ["unitId", "startsAt", "endsAt"],
          properties: { unitId: uuid, startsAt: instant, endsAt: instant },
        },
        response: {
          ...Object.fromEntries(
            [400, 401, 403, 404, 409, 429, 500, 503].map((status) => [
              status,
              { $ref: "ErrorResponse#" },
            ]),
          ),
          201: {
            headers: {
              "idempotency-replayed": {
                type: "string",
                enum: ["true", "false"],
                description: "Indica si se recuperó un resultado anterior.",
              },
              "idempotency-expires-at": {
                type: "string",
                format: "date-time",
                description: "Vencimiento del resultado guardado.",
              },
              "idempotency-retention-seconds": {
                type: "integer",
                description:
                  "Retención configurada para comandos nuevos, en segundos.",
              },
            },
            type: "object",
            additionalProperties: false,
            required: [
              "tenantId",
              "id",
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
              tenantId: uuid,
              id: uuid,
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
      const result = await createReservation(
        pool,
        await actor(request, reply),
        request.params.tenantId,
        request.headers["idempotency-key"],
        request.body,
        request.id,
        retentionSeconds,
      );
      return reply
        .code(201)
        .header("idempotency-replayed", String(result.replayed))
        .header("idempotency-expires-at", result.expiresAt)
        .header("idempotency-retention-seconds", String(retentionSeconds))
        .send(result.result);
    },
  );
}
