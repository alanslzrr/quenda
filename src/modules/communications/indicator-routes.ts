import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import {
  type AuthConfiguration,
  type Authentication,
  createRequestActor,
} from "../identity/index.ts";
import { readUnitIndicators } from "./indicator-query.ts";
export async function registerIndicatorRoutes(
  app: FastifyInstance,
  pool: Pool,
  auth: Authentication,
  config: AuthConfiguration,
) {
  const actor = createRequestActor(pool, auth, config);
  const uuid = { type: "string", format: "uuid" },
    date = { type: "string", format: "date" };
  const count = { type: "integer", minimum: 0 };
  const properties = {
    tenantId: uuid,
    unitId: uuid,
    from: date,
    to: date,
    timeZone: { type: "string" },
    asOf: { type: "string", format: "date-time" },
    reservations: {
      type: "object",
      additionalProperties: false,
      required: ["CONFIRMADA", "CANCELADA", "FINALIZADA"],
      properties: { CONFIRMADA: count, CANCELADA: count, FINALIZADA: count },
    },
    reservedMinutes: { type: "number", minimum: 0 },
    offeredMinutes: { type: "number", minimum: 0 },
    occupancyPercent: { type: "number", nullable: true },
  };
  app.get<{
    Params: { tenantId: string; unitId: string };
    Querystring: { from: string; to: string };
  }>(
    "/api/municipalities/:tenantId/units/:unitId/indicators",
    {
      schema: {
        operationId: "unitIndicators",
        tags: ["Communications"],
        security: [{ quendaSession: [] }],
        description:
          "Indicadores de una unidad con REPORT_READ y MFA. Fechas locales [from,to), hasta 366 días. Calendario y publicación históricos; porcentaje null si no hay oferta. Sin titulares ni inferencia de asistencia. Límites: 1000 versiones, 2000 cambios de publicación, 10000 reservas y 10000 cierres; reducir periodo si se exceden.",
        params: {
          type: "object",
          additionalProperties: false,
          required: ["tenantId", "unitId"],
          properties: { tenantId: uuid, unitId: uuid },
        },
        querystring: {
          type: "object",
          additionalProperties: false,
          required: ["from", "to"],
          properties: { from: date, to: date },
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
            required: Object.keys(properties),
            properties,
          },
        },
      },
    },
    async (request, reply) => {
      const account = await actor(request, reply);
      return reply
        .header("cache-control", "no-store")
        .send(
          await readUnitIndicators(
            pool,
            account,
            request.params.tenantId,
            request.params.unitId,
            request.query.from,
            request.query.to,
          ),
        );
    },
  );
}
