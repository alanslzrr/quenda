import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import {
  type AuthConfiguration,
  type Authentication,
  createRequestActor,
} from "../identity/index.ts";
import {
  type IssueCredentialInput,
  issueAgreementCredential,
  revokeAgreementCredential,
} from "./credentials.ts";

const uuid = { type: "string", format: "uuid" };
const instant = { type: "string", format: "date-time" };
const reference = { type: "string", minLength: 1, maxLength: 500 };
export async function registerCredentialRoutes(
  app: FastifyInstance,
  pool: Pool,
  auth: Authentication,
  config: AuthConfiguration,
  retentionSeconds: number,
) {
  const actor = createRequestActor(pool, auth, config);
  for (const action of ["issue", "revoke"] as const) {
    const issuing = action === "issue",
      success = issuing ? 201 : 200;
    const properties = issuing
      ? {
          agreementId: uuid,
          version: { type: "integer", minimum: 1, maximum: 2147483647 },
          accountId: { type: "string", minLength: 1, maxLength: 200 },
          startsAt: instant,
          endsAt: instant,
          verificationReference: reference,
        }
      : { reason: reference };
    const result = issuing
      ? {
          id: uuid,
          agreementId: uuid,
          version: { type: "integer" },
          revoked: { type: "boolean", enum: [false] },
        }
      : { id: uuid, revoked: { type: "boolean", enum: [true] } };
    app.post<{
      Params: { tenantId: string; credentialId?: string };
      Headers: { "idempotency-key": string };
      Body: IssueCredentialInput & { reason: string };
    }>(
      issuing
        ? "/api/municipalities/:tenantId/credentials"
        : "/api/municipalities/:tenantId/credentials/:credentialId/revoke",
      {
        schema: {
          operationId: issuing
            ? "issueAgreementCredential"
            : "revokeAgreementCredential",
          tags: ["Collaboration"],
          security: [{ quendaSession: [] }],
          description: `${issuing ? "Emite una acreditación para una cuenta vinculada al municipio emisor. Exige versión activa, vigente y configurada con acreditacion_vigente; revoked=false no afirma elegibilidad para un intervalo." : "Revoca una acreditación del municipio emisor, incluso si el convenio está suspendido. Conserva la evidencia y el primer motivo de revocación."} Exige administrador, MFA reciente, Origin autorizado e Idempotency-Key; retención ${retentionSeconds} segundos.`,
          params: {
            type: "object",
            additionalProperties: false,
            required: issuing ? ["tenantId"] : ["tenantId", "credentialId"],
            properties: issuing
              ? { tenantId: uuid }
              : { tenantId: uuid, credentialId: uuid },
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
              required: Object.keys(result),
              properties: result,
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
        const saved = issuing
          ? await issueAgreementCredential(
              pool,
              account,
              request.params.tenantId,
              request.headers["idempotency-key"],
              request.body,
              request.id,
              retentionSeconds,
            )
          : await revokeAgreementCredential(
              pool,
              account,
              request.params.tenantId,
              request.params.credentialId as string,
              request.headers["idempotency-key"],
              request.body.reason,
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
