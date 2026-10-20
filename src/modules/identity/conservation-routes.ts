import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { AuthConfiguration, Authentication } from "./auth.ts";
import {
  approveRetentionPolicy,
  executePrivacyAction,
  listRetentionPolicies,
  type PrivacyActionInput,
  type RetentionHoldInput,
  type RetentionPolicyInput,
  readRetentionStatus,
  releaseRetentionHold,
  retentionCategories,
  revokeRetentionPolicy,
  setRetentionHold,
} from "./conservation.ts";
import { createRequestActor } from "./request-actor.ts";

const uuid = { type: "string", format: "uuid" } as const;
const reason = { type: "string", minLength: 1, maxLength: 500 } as const;
const period = { type: "integer", minimum: 1, maximum: 365000 } as const;
const specification = {
  category: { type: "string", enum: [...retentionCategories] },
  retentionDays: period,
  action: { type: "string", enum: ["ERASE", "BLOCK"] },
  purpose: { type: "string", minLength: 1, maxLength: 500 },
  controllerReference: reason,
  approvalReference: reason,
  reason,
} as const;
const errors = Object.fromEntries(
  [400, 401, 403, 404, 409, 429, 500, 503].map((status) => [
    status,
    { $ref: "ErrorResponse#" },
  ]),
);
const mutation = {
  type: "object",
  additionalProperties: false,
  required: ["policyId"],
  properties: { policyId: uuid },
} as const;

export async function registerConservationRoutes(
  app: FastifyInstance,
  pool: Pool,
  auth: Authentication,
  config: AuthConfiguration,
) {
  const actor = createRequestActor(pool, auth, config);
  for (const municipal of [true, false]) {
    const path = municipal
      ? "/api/municipalities/:tenantId/retention-policies"
      : "/api/platform/retention-policies";
    const scopeParams = municipal
      ? {
          type: "object",
          additionalProperties: false,
          required: ["tenantId"],
          properties: { tenantId: uuid },
        }
      : undefined;
    app.post<{
      Params: { tenantId?: string };
      Body: RetentionPolicyInput;
    }>(
      path,
      {
        schema: {
          operationId: municipal
            ? "approveMunicipalRetentionPolicy"
            : "approveGlobalRetentionPolicy",
          tags: ["Identity"],
          security: [{ quendaSession: [] }],
          description:
            "Permiso explícito PRIVACY_EXECUTE del ámbito y MFA reciente: registra una política aprobada por el responsable. No inventa plazos ni sustituye la aprobación administrativa. La nueva versión reemplaza la anterior de su categoría y habilita la ejecución automática autorizada.",
          ...(scopeParams ? { params: scopeParams } : {}),
          body: {
            type: "object",
            additionalProperties: false,
            required: Object.keys(specification),
            properties: { ...specification, blockDays: period },
            oneOf: [
              {
                properties: { action: { const: "BLOCK" } },
                required: ["blockDays"],
              },
              {
                properties: { action: { const: "ERASE" } },
                not: { required: ["blockDays"] },
              },
            ],
          },
          response: { ...errors, 201: mutation },
        },
      },
      async (request, reply) => {
        reply.header("cache-control", "no-store");
        const result = await approveRetentionPolicy(
          pool,
          await actor(request, reply),
          municipal ? (request.params.tenantId ?? null) : null,
          request.body,
          request.id,
        );
        return reply.code(201).send(result);
      },
    );
    app.get<{ Params: { tenantId?: string } }>(
      path,
      {
        schema: {
          operationId: municipal
            ? "listMunicipalRetentionPolicies"
            : "listGlobalRetentionPolicies",
          tags: ["Identity"],
          security: [{ quendaSession: [] }],
          description:
            "Permiso explícito PRIVACY_READ del ámbito y MFA reciente: consulta las políticas y sus referencias de aprobación, incluidas versiones sustituidas o revocadas. Devuelve hasta 100 registros y señala si hay más. No accede a otros municipios.",
          ...(scopeParams ? { params: scopeParams } : {}),
          response: {
            ...errors,
            200: {
              type: "object",
              additionalProperties: false,
              required: ["policies", "hasMore"],
              properties: {
                hasMore: { type: "boolean" },
                policies: {
                  type: "array",
                  maxItems: 100,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: [
                      ...Object.keys(specification),
                      "policyId",
                      "scopeTenantId",
                      "blockDays",
                      "approvedAt",
                      "revokedAt",
                      "supersededAt",
                    ],
                    properties: {
                      ...specification,
                      policyId: uuid,
                      scopeTenantId: { ...uuid, nullable: true },
                      blockDays: { ...period, nullable: true },
                      approvedAt: { type: "string", format: "date-time" },
                      revokedAt: {
                        type: "string",
                        format: "date-time",
                        nullable: true,
                      },
                      supersededAt: {
                        type: "string",
                        format: "date-time",
                        nullable: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      async (request, reply) => {
        reply.header("cache-control", "no-store");
        return listRetentionPolicies(
          pool,
          await actor(request, reply),
          municipal ? (request.params.tenantId ?? null) : null,
        );
      },
    );
    app.post<{
      Params: { tenantId?: string; policyId: string };
      Body: { reason: string };
    }>(
      `${path}/:policyId/revoke`,
      {
        schema: {
          operationId: municipal
            ? "revokeMunicipalRetentionPolicy"
            : "revokeGlobalRetentionPolicy",
          tags: ["Identity"],
          security: [{ quendaSession: [] }],
          description:
            "Permiso explícito PRIVACY_EXECUTE del ámbito y MFA reciente: detiene nuevas actuaciones de la política con motivo auditado. No restaura datos suprimidos ni levanta restricciones existentes.",
          params: {
            type: "object",
            additionalProperties: false,
            required: ["policyId", ...(municipal ? ["tenantId"] : [])],
            properties: {
              policyId: uuid,
              ...(municipal ? { tenantId: uuid } : {}),
            },
          },
          body: {
            type: "object",
            additionalProperties: false,
            required: ["reason"],
            properties: { reason },
          },
          response: { ...errors, 200: mutation },
        },
      },
      async (request, reply) => {
        reply.header("cache-control", "no-store");
        return revokeRetentionPolicy(
          pool,
          await actor(request, reply),
          municipal ? (request.params.tenantId ?? null) : null,
          request.params.policyId,
          request.body.reason,
          request.id,
        );
      },
    );
    const holdPath = path.replace("retention-policies", "retention-holds");
    const holdResult = {
      type: "object",
      additionalProperties: false,
      required: ["holdId"],
      properties: { holdId: uuid },
    } as const;
    app.post<{ Params: { tenantId?: string }; Body: RetentionHoldInput }>(
      holdPath,
      {
        schema: {
          operationId: municipal
            ? "setMunicipalRetentionHold"
            : "setGlobalRetentionHold",
          tags: ["Identity"],
          security: [{ quendaSession: [] }],
          description:
            "Permiso PRIVACY_EXECUTE y MFA reciente: registra una excepción de conservación autorizada para un registro o un interesado, nunca ambos. Impide actuaciones destructivas sobre ese alcance; no constituye bloqueo legal ni limita por sí sola el uso ordinario de los datos.",
          ...(scopeParams ? { params: scopeParams } : {}),
          body: {
            type: "object",
            additionalProperties: false,
            required: ["category", "authorizationReference", "reason"],
            properties: {
              category: specification.category,
              targetKey: { type: "string", minLength: 1, maxLength: 500 },
              subjectId: { type: "string", minLength: 1, maxLength: 128 },
              authorizationReference: reason,
              reason,
            },
            oneOf: [{ required: ["targetKey"] }, { required: ["subjectId"] }],
          },
          response: { ...errors, 201: holdResult },
        },
      },
      async (request, reply) => {
        reply.header("cache-control", "no-store");
        const result = await setRetentionHold(
          pool,
          await actor(request, reply),
          municipal ? (request.params.tenantId ?? null) : null,
          request.body,
          request.id,
        );
        return reply.code(201).send(result);
      },
    );
    app.post<{
      Params: { tenantId?: string; holdId: string };
      Body: { authorizationReference: string; reason: string };
    }>(
      `${holdPath}/:holdId/release`,
      {
        schema: {
          operationId: municipal
            ? "releaseMunicipalRetentionHold"
            : "releaseGlobalRetentionHold",
          tags: ["Identity"],
          security: [{ quendaSession: [] }],
          description:
            "Permiso PRIVACY_EXECUTE y MFA reciente: levanta una excepción de conservación con autorización y motivo. La política vigente vuelve a determinar las actuaciones; no elimina datos directamente.",
          params: {
            type: "object",
            additionalProperties: false,
            required: ["holdId", ...(municipal ? ["tenantId"] : [])],
            properties: {
              holdId: uuid,
              ...(municipal ? { tenantId: uuid } : {}),
            },
          },
          body: {
            type: "object",
            additionalProperties: false,
            required: ["authorizationReference", "reason"],
            properties: { authorizationReference: reason, reason },
          },
          response: { ...errors, 200: holdResult },
        },
      },
      async (request, reply) => {
        reply.header("cache-control", "no-store");
        return releaseRetentionHold(
          pool,
          await actor(request, reply),
          municipal ? (request.params.tenantId ?? null) : null,
          request.params.holdId,
          request.body.authorizationReference,
          request.body.reason,
          request.id,
        );
      },
    );
    app.get<{ Params: { tenantId?: string } }>(
      path.replace("retention-policies", "retention-status"),
      {
        schema: {
          operationId: municipal
            ? "readMunicipalRetentionStatus"
            : "readGlobalRetentionStatus",
          tags: ["Identity"],
          security: [{ quendaSession: [] }],
          description:
            "Permiso PRIVACY_READ y MFA reciente: consulta excepciones activas y conflictos que requieren revisión en este ámbito. Hasta cien registros por conjunto, con indicadores de resultados adicionales. No expone el contenido de archivos bloqueados.",
          ...(scopeParams ? { params: scopeParams } : {}),
          response: {
            ...errors,
            200: {
              type: "object",
              additionalProperties: false,
              required: [
                "holds",
                "conflicts",
                "hasMoreHolds",
                "hasMoreConflicts",
              ],
              properties: {
                hasMoreHolds: { type: "boolean" },
                hasMoreConflicts: { type: "boolean" },
                holds: {
                  type: "array",
                  maxItems: 100,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: [
                      "holdId",
                      "category",
                      "targetKey",
                      "subjectId",
                      "authorizationReference",
                      "reason",
                      "createdAt",
                    ],
                    properties: {
                      holdId: uuid,
                      category: specification.category,
                      targetKey: { type: "string", nullable: true },
                      subjectId: { type: "string", nullable: true },
                      authorizationReference: reason,
                      reason,
                      createdAt: { type: "string", format: "date-time" },
                    },
                  },
                },
                conflicts: {
                  type: "array",
                  maxItems: 100,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: [
                      "policyId",
                      "category",
                      "targetKey",
                      "reason",
                      "lastSeenAt",
                    ],
                    properties: {
                      policyId: uuid,
                      category: specification.category,
                      targetKey: { type: "string" },
                      reason: { type: "string" },
                      lastSeenAt: { type: "string", format: "date-time" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      async (request, reply) => {
        reply.header("cache-control", "no-store");
        return readRetentionStatus(
          pool,
          await actor(request, reply),
          municipal ? (request.params.tenantId ?? null) : null,
        );
      },
    );
    app.post<{ Params: { tenantId?: string }; Body: PrivacyActionInput }>(
      path.replace("retention-policies", "privacy-actions"),
      {
        schema: {
          operationId: municipal
            ? "executeMunicipalPrivacyAction"
            : "executeGlobalPrivacyAction",
          tags: ["Identity"],
          security: [{ quendaSession: [] }],
          description:
            "Permiso PRIVACY_EXECUTE y MFA reciente: ejecuta una actuación individual autorizada de supresión o bloqueo. Respeta excepciones y dependencias protegidas. La respuesta distingue APPLIED, CONFLICT y ABSENT; HTTP 200 confirma la evaluación auditada, no necesariamente una supresión.",
          ...(scopeParams ? { params: scopeParams } : {}),
          body: {
            type: "object",
            additionalProperties: false,
            required: [
              "category",
              "targetKey",
              "action",
              "authorizationReference",
              "reason",
            ],
            properties: {
              category: specification.category,
              targetKey: { type: "string", minLength: 1, maxLength: 500 },
              action: specification.action,
              blockDays: period,
              authorizationReference: reason,
              reason,
            },
            oneOf: [
              {
                properties: { action: { const: "BLOCK" } },
                required: ["blockDays"],
              },
              {
                properties: { action: { const: "ERASE" } },
                not: { required: ["blockDays"] },
              },
            ],
          },
          response: {
            ...errors,
            200: {
              type: "object",
              additionalProperties: false,
              required: ["status", "eventId"],
              properties: {
                status: {
                  type: "string",
                  enum: ["APPLIED", "CONFLICT", "ABSENT"],
                },
                eventId: { type: "string", pattern: "^[1-9][0-9]*$" },
                reason: { type: "string" },
              },
            },
          },
        },
      },
      async (request, reply) => {
        reply.header("cache-control", "no-store");
        return executePrivacyAction(
          pool,
          await actor(request, reply),
          municipal ? (request.params.tenantId ?? null) : null,
          request.body,
          request.id,
        );
      },
    );
  }
}
