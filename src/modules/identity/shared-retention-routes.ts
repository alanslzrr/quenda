import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { AuthConfiguration, Authentication } from "./auth.ts";
import { createRequestActor } from "./request-actor.ts";
import {
  reviewSharedRetention,
  type SharedRetentionReview,
  type SharedRetentionTarget,
  sharedRetentionContext,
} from "./shared-retention.ts";

const uuid = { type: "string", format: "uuid" } as const;
const period = { type: "integer", minimum: 1, maximum: 365000 } as const;
const digest = { type: "string", pattern: "^[a-f0-9]{64}$" } as const;
const reason = { type: "string", minLength: 1, maxLength: 500 } as const;
const target = {
  ownerTenantId: uuid,
  category: { type: "string", enum: ["RESERVATIONS", "ACCREDITATIONS"] },
  targetKey: uuid,
  action: { type: "string", enum: ["ERASE", "BLOCK"] },
} as const;
const choice = [
  { properties: { action: { const: "BLOCK" } }, required: ["blockDays"] },
  {
    properties: { action: { const: "ERASE" } },
    not: { required: ["blockDays"] },
  },
];
const errors = Object.fromEntries(
  [400, 401, 403, 404, 409, 429, 500, 503].map((status) => [
    status,
    { $ref: "ErrorResponse#" },
  ]),
);
const controller = {
  type: "object",
  additionalProperties: false,
  required: ["tenantId", "name", "approved"],
  properties: {
    tenantId: uuid,
    name: { type: "string" },
    approved: { type: "boolean" },
  },
};
const contextResponse = {
  type: "object",
  additionalProperties: false,
  required: [...Object.keys(target), "blockDays", "digest", "controllers"],
  properties: {
    ...target,
    blockDays: { ...period, nullable: true },
    digest,
    controllers: { type: "array", items: controller },
  },
};
export async function registerSharedRetentionRoutes(
  app: FastifyInstance,
  pool: Pool,
  auth: Authentication,
  config: AuthConfiguration,
) {
  const actor = createRequestActor(pool, auth, config);
  const base = {
    tags: ["Identity"],
    security: [{ quendaSession: [] }],
    params: {
      type: "object",
      additionalProperties: false,
      required: ["tenantId"],
      properties: { tenantId: uuid },
    },
  };
  app.post<{ Params: { tenantId: string }; Body: SharedRetentionTarget }>(
    "/api/municipalities/:tenantId/shared-retention/context",
    {
      schema: {
        ...base,
        operationId: "sharedRetentionContext",
        description:
          "PRIVACY_READ y MFA reciente del municipio revisor. Consulta el objeto opaco, la actuación y los responsables históricos; nunca devuelve su contenido personal. La huella vincula el objeto, sus consumos, los responsables y la política vigente. No autoriza ni ejecuta la actuación.",
        body: {
          type: "object",
          additionalProperties: false,
          required: Object.keys(target),
          properties: { ...target, blockDays: period },
          oneOf: choice,
        },
        response: { ...errors, 200: contextResponse },
      },
    },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      return sharedRetentionContext(
        pool,
        await actor(request, reply),
        request.params.tenantId,
        request.body,
      );
    },
  );
  app.post<{ Params: { tenantId: string }; Body: SharedRetentionReview }>(
    "/api/municipalities/:tenantId/shared-retention/review",
    {
      schema: {
        ...base,
        operationId: "reviewSharedRetention",
        description:
          "PRIVACY_READ y PRIVACY_EXECUTE y MFA reciente. Registra o retira la aprobación del propio municipio para la huella exacta. Exige todos los responsables históricos y respeta excepciones y dependencias; no ejecuta supresión ni bloqueo. Un cambio de objeto, política o actuación exige nuevas revisiones.",
        body: {
          type: "object",
          additionalProperties: false,
          required: [
            ...Object.keys(target),
            "digest",
            "approved",
            "authorizationReference",
            "reason",
          ],
          properties: {
            ...target,
            blockDays: period,
            digest,
            approved: { type: "boolean" },
            authorizationReference: reason,
            reason,
          },
          oneOf: choice,
        },
        response: {
          ...errors,
          200: {
            type: "object",
            additionalProperties: false,
            required: ["digest", "approved"],
            properties: { digest, approved: { type: "boolean" } },
          },
        },
      },
    },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      return reviewSharedRetention(
        pool,
        await actor(request, reply),
        request.params.tenantId,
        request.body,
        request.id,
      );
    },
  );
}
