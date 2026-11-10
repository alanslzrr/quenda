import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import {
  type AuthConfiguration,
  type Authentication,
  createRequestActor,
} from "../identity/index.ts";
import {
  readMunicipalIndicators,
  readUnitIndicators,
  readUsageAnalytics,
} from "./indicator-query.ts";
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
  const { unitId: _unitId, ...municipalProperties } = properties;
  app.get<{
    Params: { tenantId: string };
    Querystring: { from: string; to: string };
  }>(
    "/api/municipalities/:tenantId/indicators",
    {
      schema: {
        operationId: "municipalIndicators",
        tags: ["Communications"],
        security: [{ quendaSession: [] }],
        description:
          "Indicadores de todas las unidades del municipio, incluidas las retiradas. REPORT_READ municipal y MFA; no admite permisos limitados a unidades. Periodo local [from,to), máximo 366 días. Porcentaje calculado sobre los minutos totales, null sin oferta; no mide asistencia. Mismos límites históricos por unidad que unitIndicators.",
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
            required: Object.keys(municipalProperties),
            properties: municipalProperties,
          },
        },
      },
    },
    async (request, reply) => {
      const account = await actor(request, reply);
      return reply
        .header("cache-control", "no-store")
        .send(
          await readMunicipalIndicators(
            pool,
            account,
            request.params.tenantId,
            request.query.from,
            request.query.to,
          ),
        );
    },
  );
  const minutes = { type: "number", minimum: 0 };
  const share = { type: "number", nullable: true };
  const object = (properties: Record<string, unknown>) => ({
    type: "object",
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  });
  const analytics = object({
    tenantId: uuid,
    unitId: { ...uuid, nullable: true },
    from: date,
    to: date,
    timeZone: { type: "string" },
    asOf: { type: "string", format: "date-time" },
    weekdayHours: {
      type: "array",
      items: object({
        weekday: { type: "integer", minimum: 1, maximum: 7 },
        hour: { type: "integer", minimum: 0, maximum: 23 },
        offeredMinutes: minutes,
        reservedMinutes: minutes,
        occupancyPercent: share,
      }),
    },
    units: {
      type: "array",
      items: object({
        unitId: uuid,
        name: { type: "string", nullable: true },
        offeredMinutes: minutes,
        reservedMinutes: minutes,
        occupancyPercent: share,
      }),
    },
    cancellations: object({
      reservations: count,
      cancelled: count,
      byHolder: count,
      administrative: count,
      cancelledPercent: share,
    }),
    leadTime: object({
      lessThanOneDay: count,
      oneToThreeDays: count,
      threeToSevenDays: count,
      sevenToFourteenDays: count,
      fourteenDaysOrMore: count,
    }),
    attendance: object({
      finished: count,
      arrived: count,
      arrivedPercent: share,
    }),
  });
  app.get<{
    Params: { tenantId: string };
    Querystring: { from: string; to: string; unitId?: string };
  }>(
    "/api/municipalities/:tenantId/analytics",
    {
      schema: {
        operationId: "usageAnalytics",
        tags: ["Communications"],
        security: [{ quendaSession: [] }],
        description:
          "Análisis de uso del municipio o de una unidad (unitId) en el periodo local [from,to), máximo 366 días. REPORT_READ municipal o de la unidad y MFA. weekdayHours reparte minutos ofertados y reservados por día ISO (1 = lunes) y hora local; units, por unidad, con los mismos minutos que los indicadores básicos. cancellations, leadTime (desde la creación hasta el inicio) y attendance (llegadas registradas sobre reservas confirmadas finalizadas) cuentan las reservas que empiezan en el periodo. Solo devuelve agregados, sin titulares. Hasta 20000 reservas; reducir el periodo si se excede.",
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
          200: analytics,
        },
      },
    },
    async (request, reply) => {
      const account = await actor(request, reply);
      return reply
        .header("cache-control", "no-store")
        .send(
          await readUsageAnalytics(
            pool,
            account,
            request.params.tenantId,
            request.query.unitId ?? null,
            request.query.from,
            request.query.to,
          ),
        );
    },
  );
}
