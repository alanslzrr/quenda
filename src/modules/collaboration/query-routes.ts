import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import {
  type AuthConfiguration,
  type Authentication,
  accountLabelSchema,
  createRequestActor,
} from "../identity/index.ts";
import { listAgreementVersions, readAgreementVersion } from "./queries.ts";

const uuid = { type: "string", format: "uuid" };
const instant = { type: "string", format: "date-time" };
const text = { type: "string" };
const integer = { type: "integer", minimum: 1, maximum: 2147483647 };
const summary = {
  agreementId: uuid,
  name: text,
  timeZone: text,
  version: integer,
  status: {
    type: "string",
    enum: ["BORRADOR", "APROBADO", "ACTIVADO", "SUSPENDIDO"],
  },
  startsAt: instant,
  endsAt: instant,
};
const object = (properties: Record<string, unknown>) => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const detail = {
  ...summary,
  purpose: text,
  legalBasis: text,
  responsibilities: text,
  retentionPolicy: text,
  eligibility: {
    type: "string",
    enum: ["acceso_abierto", "acreditacion_vigente"],
  },
  weeklyLimit: { ...integer, nullable: true },
  aggregateReports: { type: "boolean" },
  legalReviewReference: { ...text, nullable: true },
  reportReviewReference: { ...text, nullable: true },
  createdBy: { ...text, nullable: true },
  createdAt: instant,
  correlationId: uuid,
  participants: {
    type: "array",
    items: object({
      tenantId: uuid,
      accreditationIssuer: { type: "boolean" },
      unitIds: { type: "array", items: uuid },
    }),
  },
  approvals: {
    type: "array",
    items: object({
      tenantId: uuid,
      approvedBy: { ...text, nullable: true },
      approvedByLabel: accountLabelSchema,
      approvedAt: instant,
      correlationId: uuid,
    }),
  },
};
export async function registerAgreementQueries(
  app: FastifyInstance,
  pool: Pool,
  auth: Authentication,
  config: AuthConfiguration,
) {
  const actor = createRequestActor(pool, auth, config);
  const errors = Object.fromEntries(
    [400, 401, 403, 404, 429, 500, 503].map((status) => [
      status,
      { $ref: "ErrorResponse#" },
    ]),
  );
  app.get<{ Params: { tenantId: string }; Querystring: { after?: string } }>(
    "/api/municipalities/:tenantId/agreements",
    {
      schema: {
        operationId: "listAgreementVersions",
        tags: ["Collaboration"],
        security: [{ quendaSession: [] }],
        description:
          "Lista versiones en las que participa el municipio. Exige administrador y MFA reciente. Páginas de 20, orden estable por convenio y versión; no es un listado de versiones activas.",
        params: object({ tenantId: uuid }),
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { after: { type: "string", maxLength: 47 } },
        },
        response: {
          ...errors,
          200: object({
            items: { type: "array", items: object(summary) },
            nextCursor: { type: "string", nullable: true },
          }),
        },
      },
    },
    async (request, reply) =>
      reply
        .header("cache-control", "no-store")
        .send(
          await listAgreementVersions(
            pool,
            await actor(request, reply),
            request.params.tenantId,
            request.query.after ?? null,
          ),
        ),
  );
  app.get<{
    Params: { tenantId: string; agreementId: string; version: string };
  }>(
    "/api/municipalities/:tenantId/agreements/:agreementId/versions/:version",
    {
      schema: {
        operationId: "readAgreementVersion",
        tags: ["Collaboration"],
        security: [{ quendaSession: [] }],
        description:
          "Configuración y aprobaciones de una versión visible al administrador municipal con MFA reciente. El estado se lee de la base de datos, no de un resultado idempotente.",
        params: object({
          tenantId: uuid,
          agreementId: uuid,
          version: { type: "string", pattern: "^[1-9][0-9]{0,9}$" },
        }),
        response: { ...errors, 200: object(detail) },
      },
    },
    async (request, reply) =>
      reply
        .header("cache-control", "no-store")
        .send(
          await readAgreementVersion(
            pool,
            await actor(request, reply),
            request.params.tenantId,
            request.params.agreementId,
            Number(request.params.version),
          ),
        ),
  );
}
