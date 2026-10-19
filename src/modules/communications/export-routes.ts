import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import {
  type AuthConfiguration,
  type Authentication,
  createRequestActor,
} from "../identity/index.ts";
import {
  reservationExportExample,
  reservationExportSchema,
} from "./export-schema.ts";
import { exportReservations } from "./reservation-export.ts";

export async function registerExportRoutes(
  app: FastifyInstance,
  pool: Pool,
  auth: Authentication,
  config: AuthConfiguration,
) {
  const actor = createRequestActor(pool, auth, config);
  const uuid = { type: "string", format: "uuid" };
  const date = { type: "string", format: "date" };
  app.get<{
    Params: { tenantId: string };
    Querystring: { from: string; to: string; unitId?: string };
  }>(
    "/api/municipalities/:tenantId/exports/reservations",
    {
      schema: {
        operationId: "exportReservations",
        tags: ["Communications"],
        security: [{ quendaSession: [] }],
        description:
          "JSON quenda.reservations v1. DATA_EXPORT y RESERVATION_READ o RESERVATION_MANAGE sobre el mismo ámbito; MFA de los últimos cinco minutos. Sin unitId exige permisos municipales. Fechas locales [from,to), hasta 366 días: incluye reservas que se solapan, conservando intervalos completos. Máximo 10000 reservas; si se supera rechaza sin truncar. Incluye identificadores de titulares, nunca credenciales ni datos de otros municipios.",
        params: {
          type: "object",
          additionalProperties: false,
          required: ["tenantId"],
          properties: { tenantId: uuid },
        },
        querystring: {
          type: "object",
          additionalProperties: false,
          required: ["from", "to"],
          properties: { from: date, to: date, unitId: uuid },
        },
        response: {
          ...Object.fromEntries(
            [400, 401, 403, 404, 409, 429, 500, 503].map((status) => [
              status,
              { $ref: "ErrorResponse#" },
            ]),
          ),
          200: {
            ...reservationExportSchema,
            example: reservationExportExample,
          },
        },
      },
    },
    async (request, reply) => {
      const account = await actor(request, reply);
      const document = await exportReservations(
        pool,
        account,
        request.params.tenantId,
        request.query.from,
        request.query.to,
        request.query.unitId ?? null,
      );
      return reply
        .header("cache-control", "no-store")
        .header(
          "content-disposition",
          'attachment; filename="quenda-reservations-v1.json"',
        )
        .send(document);
    },
  );
}
