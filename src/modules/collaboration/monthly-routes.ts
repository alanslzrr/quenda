import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import {
  type AuthConfiguration,
  type Authentication,
  createRequestActor,
} from "../identity/index.ts";
import { deliverMonthlyReport } from "./monthly-delivery.ts";
import {
  type MonthlyRiskReviewInput,
  reviewMonthlyAssessment,
} from "./monthly-review.ts";
import { readMonthlyReviewContext } from "./monthly-review-context.ts";

interface Params {
  tenantId: string;
  agreementId: string;
  month: string;
}
type Recipient = Pick<
  MonthlyRiskReviewInput,
  "revision" | "recipientTenantId" | "recipientAccountId"
>;
export async function registerMonthlyReportRoutes(
  app: FastifyInstance,
  pool: Pool,
  auth: Authentication,
  config: AuthConfiguration,
  retentionSeconds: number,
) {
  const actor = createRequestActor(pool, auth, config);
  const uuid = { type: "string", format: "uuid" },
    month = { type: "string", pattern: "^[0-9]{4}-[0-9]{2}$" },
    revision = { type: "integer", minimum: 1, maximum: 2147483647 };
  const recipient = {
    revision,
    recipientTenantId: uuid,
    recipientAccountId: { type: "string", minLength: 1, maxLength: 200 },
  };
  const digest = { type: "string", pattern: "^[0-9a-f]{64}$" };
  const reference = { type: "string", minLength: 1, maxLength: 500 };
  const params = {
    type: "object",
    additionalProperties: false,
    required: ["tenantId", "agreementId", "month"],
    properties: { tenantId: uuid, agreementId: uuid, month },
  };
  const errors = Object.fromEntries(
    [400, 401, 403, 404, 409, 429, 500, 503].map((status) => [
      status,
      { $ref: "ErrorResponse#" },
    ]),
  );
  const common = {
    tags: ["Collaboration"],
    security: [{ quendaSession: [] }],
    params,
  };
  const base =
    "/api/municipalities/:tenantId/agreements/:agreementId/reports/:month";
  app.get<{
    Params: Params;
    Querystring: Omit<Recipient, "revision"> & { revision: string };
  }>(
    `${base}/review-context`,
    {
      schema: {
        ...common,
        operationId: "monthlyReviewContext",
        description:
          "Contexto de revisión sin métricas: administrador participante y MFA reciente. La huella vincula el conjunto de entregas conocidas por el destinatario; no expone su historial.",
        querystring: {
          type: "object",
          additionalProperties: false,
          required: Object.keys(recipient),
          properties: {
            ...recipient,
            revision: { type: "string", pattern: "^[1-9][0-9]{0,9}$" },
          },
        },
        response: {
          ...errors,
          200: {
            type: "object",
            additionalProperties: false,
            required: [
              "agreementId",
              "month",
              ...Object.keys(recipient),
              "historyDigest",
            ],
            properties: {
              agreementId: uuid,
              month,
              ...recipient,
              historyDigest: digest,
            },
          },
        },
      },
    },
    async (request, reply) => {
      const account = await actor(request, reply),
        p = request.params,
        q = request.query;
      return reply
        .header("cache-control", "no-store")
        .send(
          await readMonthlyReviewContext(
            pool,
            account,
            p.tenantId,
            p.agreementId,
            p.month,
            Number(q.revision),
            q.recipientTenantId,
            q.recipientAccountId,
          ),
        );
    },
  );
  const reviewProperties = {
    ...recipient,
    expectedHistoryDigest: digest,
    decision: { type: "string", enum: ["APPROVE", "REJECT"] },
    auxiliaryReference: reference,
    ownDataReference: reference,
    priorReleasesReference: reference,
    correctionReference: { ...reference, nullable: true },
  };
  app.post<{
    Params: Params;
    Body: Omit<MonthlyRiskReviewInput, "month">;
    Headers: { "idempotency-key": string };
  }>(
    `${base}/reviews`,
    {
      schema: {
        ...common,
        operationId: "reviewMonthlyAssessment",
        description: `Revisión inmutable de riesgo para un destinatario. Administrador participante, MFA reciente, Origin e Idempotency-Key; retención ${retentionSeconds}s. Correcciones requieren referencia de diferencias. No publica ni devuelve métricas.`,
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
          required: Object.keys(reviewProperties),
          properties: reviewProperties,
        },
        response: {
          ...errors,
          200: {
            type: "object",
            additionalProperties: false,
            required: [
              "reviewId",
              "agreementId",
              "month",
              "revision",
              "decision",
            ],
            properties: {
              reviewId: { type: "string", pattern: "^[0-9]+$" },
              agreementId: uuid,
              month,
              revision,
              decision: reviewProperties.decision,
            },
          },
        },
      },
    },
    async (request, reply) => {
      const account = await actor(request, reply),
        p = request.params;
      const saved = await reviewMonthlyAssessment(
        pool,
        account,
        p.tenantId,
        p.agreementId,
        request.headers["idempotency-key"],
        { ...request.body, month: p.month },
        request.id,
        retentionSeconds,
      );
      return reply
        .header("cache-control", "no-store")
        .header("idempotency-replayed", String(saved.replayed))
        .header("idempotency-expires-at", saved.expiresAt)
        .header("idempotency-retention-seconds", String(retentionSeconds))
        .send(saved.result);
    },
  );
  const published = {
    status: { type: "string", enum: ["PUBLISHABLE"] },
    agreementId: uuid,
    month,
    revision,
    cutoff: { type: "string", format: "date-time" },
    controlVersion: revision,
    reservations: { type: "integer", minimum: 0 },
    reservedMinutes: { type: "number", minimum: 0 },
  };
  app.get<{ Params: Params }>(
    base,
    {
      schema: {
        ...common,
        operationId: "deliverMonthlyReport",
        description:
          "Entrega el último informe mensual autorizado y registra su entrega atómicamente. Exige REPORT_READ municipal y MFA, capacidad vigente y revisiones favorables de todos los participantes. No admite filtros ni elección de revisión. NOT_PUBLISHABLE no incluye métricas ni causas.",
        // Without "properties" the generated contract invents query parameters named after the keywords.
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
        response: {
          ...errors,
          200: {
            anyOf: [
              {
                type: "object",
                additionalProperties: false,
                required: ["status"],
                properties: {
                  status: { type: "string", enum: ["NOT_PUBLISHABLE"] },
                },
              },
              {
                type: "object",
                additionalProperties: false,
                required: Object.keys(published),
                properties: published,
              },
            ],
          },
        },
      },
    },
    async (request, reply) => {
      const account = await actor(request, reply),
        p = request.params;
      return reply
        .header("cache-control", "no-store")
        .send(
          await deliverMonthlyReport(
            pool,
            account,
            p.tenantId,
            p.agreementId,
            p.month,
          ),
        );
    },
  );
}
