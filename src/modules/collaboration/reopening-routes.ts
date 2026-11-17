import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import {
  type AuthConfiguration,
  type Authentication,
  createRequestActor,
} from "../identity/index.ts";
import {
  type ReleaseAgreementRestrictionInput,
  readUnitAgreementRestriction,
  releaseUnitAgreementRestriction,
} from "./reopening.ts";

const uuid = { type: "string", format: "uuid" };
const integer = { type: "integer", minimum: 1, maximum: 2147483647 };
const params = {
  type: "object",
  additionalProperties: false,
  required: ["tenantId", "unitId"],
  properties: { tenantId: uuid, unitId: uuid },
};
const errors = Object.fromEntries(
  [400, 401, 403, 404, 409, 429, 500, 503].map((status) => [
    status,
    { $ref: "ErrorResponse#" },
  ]),
);
export async function registerAgreementReopeningRoutes(
  app: FastifyInstance,
  pool: Pool,
  auth: Authentication,
  config: AuthConfiguration,
  retentionSeconds: number,
) {
  const actor = createRequestActor(pool, auth, config);
  const path =
    "/api/municipalities/:tenantId/units/:unitId/agreement-restriction";
  app.get<{ Params: { tenantId: string; unitId: string } }>(
    path,
    {
      schema: {
        operationId: "readUnitAgreementRestriction",
        tags: ["Collaboration"],
        security: [{ quendaSession: [] }],
        params,
        description:
          "Consulta la restricción persistente de una unidad municipal y el nombre del convenio. Exige administrador y MFA reciente. hasRemainingAssignment incluye adscripciones actuales o programadas; no expresa disponibilidad para reservar.",
        response: {
          ...errors,
          200: {
            type: "object",
            additionalProperties: false,
            required: ["unitId", "restriction"],
            properties: {
              unitId: uuid,
              restriction: {
                type: "object",
                nullable: true,
                additionalProperties: false,
                required: [
                  "agreementId",
                  "agreementName",
                  "version",
                  "hasRemainingAssignment",
                ],
                properties: {
                  agreementId: uuid,
                  agreementName: { type: "string", nullable: true },
                  version: integer,
                  hasRemainingAssignment: { type: "boolean" },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const account = await actor(request, reply);
      return reply
        .header("cache-control", "no-store")
        .send(
          await readUnitAgreementRestriction(
            pool,
            account,
            request.params.tenantId,
            request.params.unitId,
          ),
        );
    },
  );
  app.post<{
    Params: { tenantId: string; unitId: string };
    Headers: { "idempotency-key": string };
    Body: ReleaseAgreementRestrictionInput;
  }>(
    `${path}/release`,
    {
      schema: {
        operationId: "releaseUnitAgreementRestriction",
        tags: ["Collaboration"],
        security: [{ quendaSession: [] }],
        params,
        description: `Retira una restricción sin adscripciones actuales ni programadas, comprobando la vinculación esperada. Conserva publicación, calendario, reservas y consumos. Exige administrador, MFA reciente, motivo, Origin autorizado e Idempotency-Key; retención ${retentionSeconds} segundos.`,
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
          required: ["expectedAgreementId", "expectedVersion", "reason"],
          properties: {
            expectedAgreementId: uuid,
            expectedVersion: integer,
            reason: { type: "string", minLength: 1, maxLength: 500 },
          },
        },
        response: {
          ...errors,
          200: {
            type: "object",
            additionalProperties: false,
            required: ["unitId", "removed"],
            properties: { unitId: uuid, removed: { type: "boolean" } },
            headers: {
              "idempotency-replayed": {
                type: "string",
                enum: ["true", "false"],
              },
              "idempotency-expires-at": { type: "string", format: "date-time" },
              "idempotency-retention-seconds": { type: "integer" },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const account = await actor(request, reply);
      const saved = await releaseUnitAgreementRestriction(
        pool,
        account,
        request.params.tenantId,
        request.params.unitId,
        request.headers["idempotency-key"],
        request.body,
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
}
