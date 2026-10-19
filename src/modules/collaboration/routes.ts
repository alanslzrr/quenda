import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import {
  type AuthConfiguration,
  type Authentication,
  createRequestActor,
} from "../identity/index.ts";
import { type AgreementApprovalInput, approveAgreement } from "./approvals.ts";
import {
  type AgreementDraftInput,
  type AgreementVersionInput,
  createAgreementDraft,
} from "./drafts.ts";
import { createAgreementVersion } from "./versions.ts";

const uuid = { type: "string", format: "uuid" };
const instant = { type: "string", format: "date-time" };
const text = { type: "string", minLength: 1, maxLength: 2000 };
const integer = { type: "integer", minimum: 1, maximum: 2147483647 };
const configuration = {
  startsAt: instant,
  endsAt: instant,
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
  participants: {
    type: "array",
    minItems: 1,
    items: {
      type: "object",
      additionalProperties: false,
      required: ["tenantId", "accreditationIssuer", "unitIds"],
      properties: {
        tenantId: uuid,
        accreditationIssuer: { type: "boolean" },
        unitIds: { type: "array", uniqueItems: true, items: uuid },
      },
    },
  },
};
export async function registerCollaboration(
  app: FastifyInstance,
  pool: Pool,
  auth: Authentication,
  config: AuthConfiguration,
  retentionSeconds: number,
) {
  const actor = createRequestActor(pool, auth, config);
  for (const action of ["create", "version", "approve"] as const) {
    const properties =
      action === "create"
        ? {
            ...configuration,
            name: { type: "string", minLength: 1, maxLength: 200 },
            timeZone: { type: "string", minLength: 1, maxLength: 100 },
          }
        : action === "version"
          ? { ...configuration, expectedVersion: integer }
          : {
              version: integer,
              unitIds: { type: "array", uniqueItems: true, items: uuid },
            };
    const success = action === "approve" ? 200 : 201;
    app.post<{
      Params: { tenantId: string; agreementId?: string };
      Headers: { "idempotency-key": string };
      Body: AgreementDraftInput &
        AgreementVersionInput &
        AgreementApprovalInput & { expectedVersion: number };
    }>(
      action === "create"
        ? "/api/municipalities/:tenantId/agreements"
        : `/api/municipalities/:tenantId/agreements/:agreementId/${action === "version" ? "versions" : "approve"}`,
      {
        schema: {
          operationId:
            action === "create"
              ? "createAgreementDraft"
              : action === "version"
                ? "createAgreementVersion"
                : "approveAgreement",
          tags: ["Collaboration"],
          security: [{ quendaSession: [] }],
          description: `${action === "create" ? "Crea un convenio en BORRADOR sin activar capacidades." : action === "version" ? "Crea una nueva versión BORRADOR sin heredar aprobaciones; exige expectedVersion vigente y conserva la zona del convenio." : "Aprueba la versión y el conjunto exacto de unidades del municipio; todas las aprobaciones producen APROBADO, nunca ACTIVADO."} Exige administrador participante, MFA reciente y Origin autorizado. Retención idempotente: ${retentionSeconds} segundos.`,
          params: {
            type: "object",
            additionalProperties: false,
            required:
              action === "create" ? ["tenantId"] : ["tenantId", "agreementId"],
            properties:
              action === "create"
                ? { tenantId: uuid }
                : { tenantId: uuid, agreementId: uuid },
          },
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
            required: Object.keys(properties),
            properties,
          },
          response: {
            ...Object.fromEntries(
              [400, 401, 403, 404, 409, 429, 500, 503].map((status) => [
                status,
                { $ref: "ErrorResponse#" },
              ]),
            ),
            [success]: {
              type: "object",
              additionalProperties: false,
              required: ["agreementId", "version", "status"],
              properties: {
                agreementId: uuid,
                version: integer,
                status: { type: "string", enum: ["BORRADOR", "APROBADO"] },
              },
              headers: {
                "idempotency-replayed": {
                  type: "string",
                  enum: ["true", "false"],
                },
                "idempotency-expires-at": instant,
                "idempotency-retention-seconds": { type: "integer" },
              },
            },
          },
        },
      },
      async (request, reply) => {
        const account = await actor(request, reply);
        const saved =
          action === "create"
            ? await createAgreementDraft(
                pool,
                account,
                request.params.tenantId,
                request.headers["idempotency-key"],
                request.body,
                request.id,
                retentionSeconds,
              )
            : action === "version"
              ? await createAgreementVersion(
                  pool,
                  account,
                  request.params.tenantId,
                  request.params.agreementId as string,
                  request.headers["idempotency-key"],
                  request.body,
                  request.id,
                  retentionSeconds,
                )
              : await approveAgreement(
                  pool,
                  account,
                  request.params.tenantId,
                  request.params.agreementId as string,
                  request.headers["idempotency-key"],
                  request.body,
                  request.id,
                  retentionSeconds,
                );
        return reply
          .code(success)
          .header("cache-control", "no-store")
          .header("idempotency-replayed", String(saved.replayed))
          .header("idempotency-expires-at", saved.expiresAt)
          .header("idempotency-retention-seconds", String(retentionSeconds))
          .send(saved.result);
      },
    );
  }
}
