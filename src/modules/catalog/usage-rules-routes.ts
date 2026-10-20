import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import {
  type AuthConfiguration,
  type Authentication,
  createRequestActor,
} from "../identity/index.ts";
import { publicRateLimit } from "./public-limit.ts";
import {
  publicUsageRules,
  readUsageRules,
  saveUsageRules,
  type UsageRulesInput,
} from "./usage-rules.ts";

const uuid = { type: "string", format: "uuid" };
const version = { type: "integer", minimum: 1, maximum: 2147483647 };
const params = {
  type: "object",
  additionalProperties: false,
  required: ["tenantId", "unitId"],
  properties: { tenantId: uuid, unitId: uuid },
};
const properties = {
  tenantId: uuid,
  unitId: uuid,
  version,
  text: { type: "string", minLength: 1, maxLength: 20000 },
};
const administrativeProperties = {
  ...properties,
  actorId: { type: "string" },
  reason: { type: "string" },
  correlationId: uuid,
  createdAt: { type: "string", format: "date-time" },
};
const response = (fields: Record<string, unknown>) => ({
  ...Object.fromEntries(
    [400, 401, 403, 404, 409, 429, 500, 503].map((status) => [
      status,
      { $ref: "ErrorResponse#" },
    ]),
  ),
  200: {
    type: "object",
    additionalProperties: false,
    required: Object.keys(fields),
    properties: fields,
  },
});
export async function registerUsageRulesRoutes(
  app: FastifyInstance,
  pool: Pool,
  auth: Authentication,
  config: AuthConfiguration,
) {
  const actor = createRequestActor(pool, auth, config);
  const url = "/api/municipalities/:tenantId/units/:unitId/usage-rules";
  app.put<{
    Params: { tenantId: string; unitId: string };
    Body: UsageRulesInput;
  }>(
    url,
    {
      schema: {
        operationId: "saveUsageRules",
        tags: ["Catalog"],
        security: [{ quendaSession: [] }],
        params,
        response: response(administrativeProperties),
        description:
          "Crea una versión inmutable de normas en texto plano. Requiere CATALOG_MANAGE y MFA reciente. expectedVersion=0 crea la primera versión; una versión obsoleta devuelve 409. No modifica aceptaciones anteriores.",
        body: {
          type: "object",
          additionalProperties: false,
          required: ["expectedVersion", "text", "reason"],
          properties: {
            expectedVersion: { ...version, minimum: 0, maximum: 2147483646 },
            text: properties.text,
            reason: { type: "string", minLength: 1, maxLength: 500 },
          },
        },
      },
    },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      return saveUsageRules(
        pool,
        await actor(request, reply),
        request.params.tenantId,
        request.params.unitId,
        request.body,
        request.id,
      );
    },
  );
  app.get<{
    Params: { tenantId: string; unitId: string };
    Querystring: { version?: string };
  }>(
    url,
    {
      schema: {
        operationId: "readUsageRules",
        tags: ["Catalog"],
        security: [{ quendaSession: [] }],
        params,
        response: response(administrativeProperties),
        description:
          "Consulta administrativa de normas vigentes o de una versión histórica. Requiere CATALOG_MANAGE y MFA reciente.",
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            version: { type: "string", pattern: "^[1-9][0-9]{0,9}$" },
          },
        },
      },
    },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      return readUsageRules(
        pool,
        await actor(request, reply),
        request.params.tenantId,
        request.params.unitId,
        request.query.version ? Number(request.query.version) : null,
      );
    },
  );
  app.get<{ Params: { tenantId: string; unitId: string } }>(
    "/api/public/municipalities/:tenantId/units/:unitId/usage-rules",
    {
      onRequest: publicRateLimit(pool, config.secret),
      schema: {
        operationId: "publicUsageRules",
        tags: ["Public catalog"],
        security: [],
        params,
        response: response(properties),
        description:
          "Normas vigentes de una unidad y su instalación publicadas y no retiradas. No expone autor, motivo ni correlación internos; devuelve 404 si no hay normas. El texto es plano, no HTML.",
      },
    },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      return publicUsageRules(
        pool,
        request.params.tenantId,
        request.params.unitId,
      );
    },
  );
}
