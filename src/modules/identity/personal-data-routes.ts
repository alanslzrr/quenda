import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { AuthConfiguration, Authentication } from "./auth.ts";
import {
  exportGlobalPersonalData,
  exportMunicipalPersonalData,
  exportOwnPersonalData,
  type PersonalDataAuthorization,
} from "./personal-data.ts";
import { createRequestActor } from "./request-actor.ts";

const tenantId = { type: "string", format: "uuid" } as const;
const nullableTenantId = { ...tenantId, nullable: true } as const;
const accountId = { type: "string", minLength: 1, maxLength: 128 } as const;
const categories = [
  "IDENTITY",
  "AUTHENTICATION",
  "MUNICIPAL_PROFILE",
  "RESERVATIONS",
  "COMMUNICATIONS",
  "AUTHORITY",
  "ACCREDITATIONS",
] as const;
const category = { type: "string", enum: categories } as const;
const stringArray = { type: "array", items: { type: "string" } } as const;
const object = (properties: Record<string, unknown>) => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const personalDataSchema = object({
  format: { type: "string", const: "quenda.personal-data" },
  version: { type: "integer", const: 1 },
  generatedAt: { type: "string", format: "date-time" },
  subjectAccountId: accountId,
  scope: object({
    kind: { type: "string", enum: ["SELF", "MUNICIPAL", "GLOBAL"] },
    tenantId: nullableTenantId,
  }),
  completeness: object({
    status: { type: "string", const: "PARTIAL" },
    projectedRecordsIncluded: { type: "boolean", const: true },
    legalAccessResponseComplete: { type: "boolean", const: false },
    portabilityAssessment: { type: "string", const: "NOT_ASSESSED" },
    restrictedCategories: {
      type: "array",
      items: object({ category, tenantId: nullableTenantId }),
    },
    reviewRequired: stringArray,
    excludedSecurityMaterial: stringArray,
    administrativeChannel: { type: "string" },
    controllerInformationStatus: { type: "string", const: "NOT_CONFIGURED" },
  }),
  records: {
    type: "array",
    maxItems: 10000,
    items: object({
      category,
      tenantId: nullableTenantId,
      type: { type: "string" },
      data: { type: "object", additionalProperties: true },
    }),
  },
});
const authorizationSchema = object({
  reason: { type: "string", minLength: 1, maxLength: 500 },
  authorizationReference: { type: "string", minLength: 1, maxLength: 500 },
});
const responses = {
  ...Object.fromEntries(
    [400, 401, 403, 404, 409, 429, 500, 503].map((status) => [
      status,
      { $ref: "ErrorResponse#" },
    ]),
  ),
  200: personalDataSchema,
};

export async function registerPersonalDataRoutes(
  app: FastifyInstance,
  pool: Pool,
  auth: Authentication,
  config: AuthConfiguration,
) {
  const actor = createRequestActor(pool, auth, config);
  app.get(
    "/api/me/personal-data",
    {
      schema: {
        operationId: "exportOwnPersonalData",
        tags: ["Identity"],
        security: [{ quendaSession: [] }],
        description:
          "Descarga personal JSON v1: identidad y datos propios de todos los municipios. No contiene credenciales secretas ni información de terceros. Declara las exclusiones y la revisión administrativa necesaria; no equivale a una respuesta completa al derecho de acceso ni acredita portabilidad. Rechaza conjuntos superiores a 10 000 registros o 10 MiB, sin truncarlos.",
        response: responses,
      },
    },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      reply.header(
        "content-disposition",
        'attachment; filename="quenda-personal-data.json"',
      );
      return exportOwnPersonalData(
        pool,
        await actor(request, reply),
        request.id,
      );
    },
  );
  app.post<{
    Params: { tenantId: string; accountId: string };
    Body: PersonalDataAuthorization;
  }>(
    "/api/municipalities/:tenantId/accounts/:accountId/personal-data",
    {
      schema: {
        operationId: "exportMunicipalPersonalData",
        tags: ["Identity"],
        security: [{ quendaSession: [] }],
        description:
          "Permiso expreso PRIVACY_READ municipal y MFA reciente: prepara los datos del interesado exclusivamente en ese municipio, incluso con cuenta desactivada o suspendida. Requiere motivo y referencia a la autorización tramitada fuera de Quenda. No incluye identidad global ni datos de otros municipios; las exclusiones requieren revisión administrativa.",
        params: object({ tenantId, accountId }),
        body: authorizationSchema,
        response: responses,
      },
    },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      return exportMunicipalPersonalData(
        pool,
        await actor(request, reply),
        request.params.tenantId,
        request.params.accountId,
        request.body,
        request.id,
      );
    },
  );
  app.post<{
    Params: { accountId: string };
    Body: PersonalDataAuthorization;
  }>(
    "/api/platform/accounts/:accountId/personal-data",
    {
      schema: {
        operationId: "exportGlobalPersonalData",
        tags: ["Identity"],
        security: [{ quendaSession: [] }],
        description:
          "Permiso expreso PRIVACY_READ global y MFA reciente: prepara solo identidad global y metadatos de seguridad del interesado, sin actividad municipal. Admite cuentas desactivadas o suspendidas; exige motivo y referencia a la autorización externa. El rol de operador por sí solo no autoriza esta descarga.",
        params: object({ accountId }),
        body: authorizationSchema,
        response: responses,
      },
    },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      return exportGlobalPersonalData(
        pool,
        await actor(request, reply),
        request.params.accountId,
        request.body,
        request.id,
      );
    },
  );
}
