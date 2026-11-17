import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import {
  type AuthConfiguration,
  type Authentication,
  accountLabelSchema,
  createRequestActor,
} from "../identity/index.ts";
import {
  issuedCredentials,
  monthlyReviewOptions,
  reportAgreementOptions,
} from "./navigation.ts";

export async function registerCollaborationNavigation(
  app: FastifyInstance,
  pool: Pool,
  auth: Authentication,
  config: AuthConfiguration,
) {
  const actor = createRequestActor(pool, auth, config);
  const uuid = { type: "string", format: "uuid" };
  const month = {
    type: "string",
    pattern: "^(?!0000)[0-9]{4}-(0[1-9]|1[0-2])$",
  };
  const instant = { type: "string", format: "date-time" };
  const errors = Object.fromEntries(
    [400, 401, 403, 429, 500, 503].map((code) => [
      code,
      { $ref: "ErrorResponse#" },
    ]),
  );
  const page = (
    properties: Record<string, unknown>,
    cursor: Record<string, unknown>,
  ) => ({
    type: "object",
    additionalProperties: false,
    required: ["items", "nextCursor"],
    properties: {
      items: {
        type: "array",
        maxItems: 20,
        items: {
          type: "object",
          additionalProperties: false,
          required: Object.keys(properties),
          properties,
        },
      },
      nextCursor: { ...cursor, nullable: true },
    },
  });
  app.get<{ Params: { tenantId: string }; Querystring: { after?: string } }>(
    "/api/municipalities/:tenantId/credentials",
    {
      schema: {
        operationId: "listIssuedCredentials",
        tags: ["Collaboration"],
        security: [{ quendaSession: [] }],
        description:
          "Administrador municipal con MFA reciente. Solo acreditaciones emitidas por su municipio, sin referencias de verificación ni acreditaciones ajenas.",
        params: {
          type: "object",
          additionalProperties: false,
          required: ["tenantId"],
          properties: { tenantId: uuid },
        },
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { after: uuid },
        },
        response: {
          ...errors,
          200: page(
            {
              id: uuid,
              agreementId: uuid,
              agreementName: { type: "string" },
              accountId: { type: "string" },
              accountLabel: accountLabelSchema,
              startsAt: instant,
              endsAt: instant,
              revokedAt: { ...instant, nullable: true },
            },
            uuid,
          ),
        },
      },
    },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      return issuedCredentials(
        pool,
        await actor(request, reply),
        request.params.tenantId,
        request.query.after ?? null,
      );
    },
  );
  app.get<{ Params: { tenantId: string }; Querystring: { after?: string } }>(
    "/api/municipalities/:tenantId/report-agreements",
    {
      schema: {
        operationId: "listReportAgreements",
        tags: ["Collaboration"],
        security: [{ quendaSession: [] }],
        description:
          "Convenios cuyo informe mensual puede solicitarse: REPORT_READ municipal y MFA. Solo convenios con una versión activada con informes agregados en la que participa el municipio; nombre y última versión, sin otros participantes, meses, métricas ni revisiones.",
        params: {
          type: "object",
          additionalProperties: false,
          required: ["tenantId"],
          properties: { tenantId: uuid },
        },
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { after: uuid },
        },
        response: {
          ...errors,
          200: page(
            {
              agreementId: uuid,
              name: { type: "string" },
              version: { type: "integer", minimum: 1 },
            },
            uuid,
          ),
        },
      },
    },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      return reportAgreementOptions(
        pool,
        await actor(request, reply),
        request.params.tenantId,
        request.query.after ?? null,
      );
    },
  );
  app.get<{
    Params: { tenantId: string; agreementId: string };
    Querystring: { after?: string };
  }>(
    "/api/municipalities/:tenantId/agreements/:agreementId/review-options",
    {
      schema: {
        operationId: "monthlyReviewOptions",
        tags: ["Collaboration"],
        security: [{ quendaSession: [] }],
        description:
          "Administrador con MFA reciente. Metadatos de la última revisión preparada de cada mes en que participa su municipio; sin métricas, estado de supresión ni directorio de destinatarios.",
        params: {
          type: "object",
          additionalProperties: false,
          required: ["tenantId", "agreementId"],
          properties: { tenantId: uuid, agreementId: uuid },
        },
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { after: month },
        },
        response: {
          ...errors,
          200: page(
            {
              month,
              revision: { type: "integer" },
              participants: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["id", "name"],
                  properties: { id: uuid, name: { type: "string" } },
                },
              },
            },
            month,
          ),
        },
      },
    },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      return monthlyReviewOptions(
        pool,
        await actor(request, reply),
        request.params.tenantId,
        request.params.agreementId,
        request.query.after ?? null,
      );
    },
  );
}
