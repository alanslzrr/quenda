import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { publicRateLimit } from "../../http/public-rate-limit.ts";
import type { AuthConfiguration, Authentication } from "./auth.ts";
import {
  conformanceStatuses,
  type NoticeBody,
  type NoticeKind,
  noticeFields,
  noticeKinds,
  publicNotice,
  saveNotice,
} from "./legal-notices.ts";
import { createRequestActor } from "./request-actor.ts";

const uuid = { type: "string", format: "uuid" } as const;
const errors = Object.fromEntries(
  [400, 401, 403, 404, 409, 429, 500, 503].map((status) => [
    status,
    { $ref: "ErrorResponse#" },
  ]),
);
const localized = {
  type: "object",
  additionalProperties: { type: "string", maxLength: 4000 },
} as const;
const bodyProperties = {
  gl: localized,
  es: localized,
  status: { type: "string", enum: conformanceStatuses },
  preparedOn: { type: "string", format: "date" },
  reviewedOn: { type: "string", format: "date" },
} as const;
// A scope with nothing published answers with an empty body; a save must carry something.
const readSchema = {
  type: "object",
  additionalProperties: false,
  properties: bodyProperties,
} as const;
const bodySchema = { ...readSchema, minProperties: 1 } as const;
const noticeResponse = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "version", "body", "publishedAt"],
  properties: {
    kind: { type: "string", enum: noticeKinds },
    version: { type: "integer", minimum: 0 },
    body: readSchema,
    publishedAt: { type: "string", format: "date-time", nullable: true },
  },
} as const;
const fieldList = (kind: NoticeKind) => noticeFields[kind].join(", ");
const description =
  "Campos por tipo (variantes gl y es): privacy: " +
  `${fieldList("privacy")}; legal: ${fieldList("legal")}; accessibility: ${fieldList("accessibility")}, ` +
  "más status (full, partial, none), preparedOn y reviewedOn. Los textos se recortan, los vacíos se descartan y no admiten campos ajenos al tipo.";

export async function registerLegalNoticeRoutes(
  app: FastifyInstance,
  pool: Pool,
  auth: Authentication,
  config: AuthConfiguration,
) {
  const actor = createRequestActor(pool, auth, config);
  const limit = publicRateLimit(pool, config.secret);
  const kindParam = { type: "string", enum: noticeKinds } as const;
  const publicSchema = (operationId: string, tenant: boolean) => ({
    operationId,
    tags: ["Legal"],
    security: [],
    description: `Último texto publicado ${tenant ? "por el municipio" : "para la instancia"}. Con versión 0 y cuerpo vacío no hay texto publicado todavía. ${description}`,
    params: {
      type: "object",
      additionalProperties: false,
      required: tenant ? ["tenantId", "kind"] : ["kind"],
      properties: tenant
        ? { tenantId: uuid, kind: kindParam }
        : { kind: kindParam },
    },
    response: { ...errors, 200: noticeResponse },
  });
  app.get<{ Params: { kind: NoticeKind } }>(
    "/api/public/notices/:kind",
    { onRequest: limit, schema: publicSchema("publicInstanceNotice", false) },
    (request) => publicNotice(pool, null, request.params.kind),
  );
  app.get<{ Params: { tenantId: string; kind: NoticeKind } }>(
    "/api/public/municipalities/:tenantId/notices/:kind",
    { onRequest: limit, schema: publicSchema("publicMunicipalNotice", true) },
    (request) =>
      publicNotice(pool, request.params.tenantId, request.params.kind),
  );
  const saveSchema = (operationId: string, tenant: boolean) => ({
    operationId,
    tags: ["Legal"],
    security: [{ quendaSession: [] }],
    description: `Publica una versión nueva. Exige ${tenant ? "administración del municipio" : "permiso de operador"}, MFA reciente y expectedVersion igual a la versión vigente (0 si no hay ninguna); otra versión devuelve CONFLICT. Las versiones anteriores se conservan sin cambios. ${description}`,
    params: {
      type: "object",
      additionalProperties: false,
      required: tenant ? ["tenantId", "kind"] : ["kind"],
      properties: tenant
        ? { tenantId: uuid, kind: kindParam }
        : { kind: kindParam },
    },
    body: {
      type: "object",
      additionalProperties: false,
      required: ["expectedVersion", "body"],
      properties: {
        expectedVersion: { type: "integer", minimum: 0, maximum: 2147483646 },
        body: bodySchema,
      },
    },
    response: {
      ...errors,
      200: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "version"],
        properties: {
          kind: { type: "string", enum: noticeKinds },
          version: { type: "integer", minimum: 1 },
        },
      },
    },
  });
  type SaveBody = { expectedVersion: number; body: NoticeBody };
  app.put<{
    Params: { tenantId: string; kind: NoticeKind };
    Body: SaveBody;
  }>(
    "/api/municipalities/:tenantId/notices/:kind",
    { schema: saveSchema("saveMunicipalNotice", true) },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      return saveNotice(
        pool,
        await actor(request, reply),
        request.params.tenantId,
        request.params.kind,
        request.body,
        request.id,
      );
    },
  );
  app.put<{ Params: { kind: NoticeKind }; Body: SaveBody }>(
    "/api/platform/notices/:kind",
    { schema: saveSchema("saveInstanceNotice", false) },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      return saveNotice(
        pool,
        await actor(request, reply),
        null,
        request.params.kind,
        request.body,
        request.id,
      );
    },
  );
}
