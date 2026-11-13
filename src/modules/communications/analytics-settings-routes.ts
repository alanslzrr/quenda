import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import {
  type AuthConfiguration,
  type Authentication,
  createRequestActor,
} from "../identity/index.ts";
import {
  type AnalyticsSettingsInput,
  analyticsPeriods,
  readAnalyticsSettings,
  saveAnalyticsSettings,
} from "./analytics-settings.ts";

export async function registerAnalyticsSettingsRoutes(
  app: FastifyInstance,
  pool: Pool,
  auth: Authentication,
  config: AuthConfiguration,
) {
  const actor = createRequestActor(pool, auth, config);
  const percent = { type: "integer", minimum: 1, maximum: 99 };
  const fields = {
    highDemandPercent: percent,
    lowUsePercent: percent,
    defaultPeriod: { type: "string", enum: analyticsPeriods },
  };
  const path = "/api/municipalities/:tenantId/analytics/settings";
  const schema = {
    tags: ["Communications"],
    security: [{ quendaSession: [] }],
    params: {
      type: "object",
      additionalProperties: false,
      required: ["tenantId"],
      properties: { tenantId: { type: "string", format: "uuid" } },
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
        required: ["version", ...Object.keys(fields)],
        properties: { version: { type: "integer", minimum: 1 }, ...fields },
      },
    },
  };
  app.get<{ Params: { tenantId: string } }>(
    path,
    {
      schema: {
        ...schema,
        operationId: "analyticsSettings",
        description:
          "Ajustes de analítica del municipio: umbrales de ocupación para «alta demanda» (igual o superior) y «poco uso» (inferior), y periodo inicial. Lectura con REPORT_READ municipal o de alguna unidad y MFA.",
      },
    },
    async (request, reply) => {
      const account = await actor(request, reply);
      return reply
        .header("cache-control", "no-store")
        .send(
          await readAnalyticsSettings(pool, account, request.params.tenantId),
        );
    },
  );
  app.put<{ Params: { tenantId: string }; Body: AnalyticsSettingsInput }>(
    path,
    {
      schema: {
        ...schema,
        operationId: "saveAnalyticsSettings",
        description:
          "Administrador municipal con MFA reciente. Umbrales enteros entre 1 y 99, con «poco uso» menor que «alta demanda», y uno de los periodos predefinidos. Control de versión y auditoría; afecta a todas las personas que analizan el municipio.",
        body: {
          type: "object",
          additionalProperties: false,
          required: ["expectedVersion", ...Object.keys(fields)],
          properties: {
            expectedVersion: {
              type: "integer",
              minimum: 1,
              maximum: 2147483646,
            },
            ...fields,
          },
        },
      },
    },
    async (request, reply) =>
      saveAnalyticsSettings(
        pool,
        await actor(request, reply),
        request.params.tenantId,
        request.body,
        request.id,
      ),
  );
}
