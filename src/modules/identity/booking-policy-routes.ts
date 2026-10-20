import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { AuthConfiguration, Authentication } from "./auth.ts";
import {
  type BookingPolicyInput,
  readBookingPolicy,
  saveBookingPolicy,
} from "./booking-policy.ts";
import { createRequestActor } from "./request-actor.ts";

export async function registerBookingPolicyRoutes(
  app: FastifyInstance,
  pool: Pool,
  auth: Authentication,
  config: AuthConfiguration,
) {
  const actor = createRequestActor(pool, auth, config);
  const integer = { type: "integer", minimum: 0, maximum: 2147483647 };
  const schema = {
    tags: ["Identity"],
    security: [{ quendaSession: [] }],
    params: {
      type: "object",
      additionalProperties: false,
      required: ["tenantId"],
      properties: { tenantId: { type: "string", format: "uuid" } },
    },
    response: {
      ...Object.fromEntries(
        [400, 401, 403, 404, 409, 429, 500, 503].map((status) => [
          status,
          { $ref: "ErrorResponse#" },
        ]),
      ),
      200: {
        type: "object",
        additionalProperties: false,
        required: ["tenantId", "version", "advanceDays", "cancellationMinutes"],
        properties: {
          tenantId: { type: "string", format: "uuid" },
          version: { ...integer, minimum: 1 },
          advanceDays: integer,
          cancellationMinutes: integer,
        },
      },
    },
  };
  app.get<{ Params: { tenantId: string } }>(
    "/api/municipalities/:tenantId/booking-policy",
    {
      schema: {
        ...schema,
        operationId: "readMunicipalBookingPolicy",
        description:
          "Consulta la configuración de reservas. Exige administrador municipal y MFA reciente.",
      },
    },
    async (request, reply) =>
      readBookingPolicy(
        pool,
        await actor(request, reply),
        request.params.tenantId,
      ),
  );
  app.put<{ Params: { tenantId: string }; Body: BookingPolicyInput }>(
    "/api/municipalities/:tenantId/booking-policy",
    {
      schema: {
        ...schema,
        operationId: "saveMunicipalBookingPolicy",
        description:
          "Actualiza antelación y plazo con control de versión y motivo. Exige administrador municipal, MFA reciente y Origin autorizado. Devuelve 409 si alguna unidad tiene una antelación mayor que el nuevo límite municipal. Las reservas existentes conservan su plazo aceptado; la nueva configuración rige nuevas reservas y reprogramaciones.",
        body: {
          type: "object",
          additionalProperties: false,
          required: [
            "expectedVersion",
            "advanceDays",
            "cancellationMinutes",
            "reason",
          ],
          properties: {
            expectedVersion: { ...integer, minimum: 1, maximum: 2147483646 },
            advanceDays: integer,
            cancellationMinutes: integer,
            reason: { type: "string", minLength: 1, maxLength: 500 },
          },
        },
      },
    },
    async (request, reply) =>
      saveBookingPolicy(
        pool,
        await actor(request, reply),
        request.params.tenantId,
        request.body,
        request.id,
      ),
  );
}
