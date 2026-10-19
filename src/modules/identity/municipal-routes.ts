import { fromNodeHeaders } from "better-auth/node";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { HttpError } from "../../http/errors.ts";
import type { AuthConfiguration, Authentication } from "./auth.ts";
import {
  acceptAdministratorInvitation,
  createMunicipality,
  type MunicipalityInput,
} from "./municipality.ts";

import { consumeAdministrativeAttempt } from "./rate-limit.ts";

const uuid = { type: "string", format: "uuid" } as const;
const errors = Object.fromEntries(
  [400, 401, 403, 404, 409, 429, 500].map((status) => [
    status,
    { $ref: "ErrorResponse#" },
  ]),
);

export async function registerMunicipalIdentity(
  app: FastifyInstance,
  pool: Pool,
  auth: Authentication,
  config: AuthConfiguration,
) {
  const actor = async (request: FastifyRequest, reply: FastifyReply) => {
    // Cookie-based mutation requires the configured Origin, not Host or proxy
    // headers. Missing Origin is rejected too, including requests from scripts.
    if (
      request.headers.origin !== config.origin ||
      request.headers["sec-fetch-site"] === "cross-site"
    )
      throw new HttpError("FORBIDDEN");
    const account = await auth.authenticate(fromNodeHeaders(request.headers));
    if (!account) throw new HttpError("UNAUTHENTICATED");
    const limit = await consumeAdministrativeAttempt(pool, account.accountId);
    if (!limit.allowed) {
      reply.header("retry-after", limit.retryAfter);
      throw new HttpError("RATE_LIMITED");
    }
    return account;
  };
  app.post<{ Body: MunicipalityInput }>(
    "/api/municipalities",
    {
      schema: {
        operationId: "createMunicipality",
        tags: ["Identity"],
        security: [{ quendaSession: [] }],
        description:
          "Operador con MFA verificado en los últimos cinco minutos: crea el municipio e invita a una cuenta existente como primer administrador. Origin debe coincidir con AUTH_ORIGIN.",
        body: {
          type: "object",
          additionalProperties: false,
          required: [
            "name",
            "timezone",
            "administratorId",
            "invitationExpiresAt",
          ],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 200 },
            timezone: { type: "string", minLength: 1, maxLength: 100 },
            administratorId: { type: "string", minLength: 1, maxLength: 128 },
            invitationExpiresAt: { type: "string", format: "date-time" },
          },
        },
        response: {
          ...errors,
          201: {
            type: "object",
            additionalProperties: false,
            required: ["tenantId", "invitationId"],
            properties: { tenantId: uuid, invitationId: uuid },
          },
        },
      },
    },
    async (request, reply) => {
      const account = await actor(request, reply);
      return reply
        .code(201)
        .send(await createMunicipality(pool, account, request.body));
    },
  );
  app.post<{
    Params: { tenantId: string; invitationId: string };
    Body: Record<string, never>;
  }>(
    "/api/municipalities/:tenantId/administrator-invitations/:invitationId/accept",
    {
      schema: {
        operationId: "acceptAdministratorInvitation",
        tags: ["Identity"],
        security: [{ quendaSession: [] }],
        description:
          "Acepta una invitación vigente de la cuenta autenticada con MFA verificado en los últimos cinco minutos. No admite una cuenta ni un rol alternativo en el cuerpo. Origin debe coincidir con AUTH_ORIGIN.",
        params: {
          type: "object",
          additionalProperties: false,
          required: ["tenantId", "invitationId"],
          properties: { tenantId: uuid, invitationId: uuid },
        },
        body: { type: "object", additionalProperties: false, maxProperties: 0 },
        response: {
          ...errors,
          200: {
            type: "object",
            additionalProperties: false,
            required: ["tenantId"],
            properties: { tenantId: uuid },
          },
        },
      },
    },
    async (request, reply) =>
      acceptAdministratorInvitation(
        pool,
        await actor(request, reply),
        request.params.tenantId,
        request.params.invitationId,
      ),
  );
}
