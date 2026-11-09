import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { calendarSchema } from "./calendar-routes.ts";
import { facilityProfileSchema, unitProfileSchema } from "./profile-schema.ts";
import {
  publicAvailability,
  publicAvailabilitySearch,
  publicBookingDurations,
  publicFacilities,
  publicUnitCalendar,
  publicUnits,
} from "./public.ts";
import { publicRateLimit } from "./public-limit.ts";

const uuid = { type: "string", format: "uuid" };
const text = { type: "string" };
const errors = Object.fromEntries(
  [400, 404, 429, 500, 503].map((status) => [
    status,
    { $ref: "ErrorResponse#" },
  ]),
);
const query = {
  type: "object",
  additionalProperties: false,
  properties: { after: uuid },
};
const params = (extra: Record<string, unknown> = {}) => ({
  type: "object",
  additionalProperties: false,
  required: ["tenantId", ...Object.keys(extra)],
  properties: { tenantId: uuid, ...extra },
});
const page = (properties: Record<string, unknown>) => ({
  type: "object",
  additionalProperties: false,
  required: ["items", "nextCursor"],
  properties: {
    nextCursor: { ...uuid, nullable: true },
    items: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        required: Object.keys(properties),
        properties,
      },
    },
  },
});
const instant = {
  type: "object",
  additionalProperties: false,
  required: ["utc", "local", "offset", "timeZone"],
  properties: {
    utc: { type: "string", format: "date-time" },
    local: text,
    offset: text,
    timeZone: text,
  },
};
export async function registerPublicCatalog(
  app: FastifyInstance,
  pool: Pool,
  secret: string,
) {
  const limit = publicRateLimit(pool, secret);

  app.get<{ Params: { tenantId: string } }>(
    "/api/public/municipalities/:tenantId/booking-durations",
    {
      onRequest: limit,
      schema: {
        operationId: "publicBookingDurations",
        tags: ["Public catalog"],
        security: [],
        params: params(),
        response: {
          ...errors,
          200: {
            type: "object",
            required: ["durations"],
            properties: {
              hasMore: { type: "boolean" },
              durations: { type: "array", items: { type: "integer" } },
              recommended: {
                type: "integer",
                description:
                  "Duración admitida por más unidades publicadas; en empate, la más corta.",
              },
            },
          },
        },
      },
    },
    (request) => publicBookingDurations(pool, request.params.tenantId),
  );
  app.get<{
    Params: { tenantId: string };
    Querystring: {
      date: string;
      durationMinutes: string;
      after?: string;
      facilityId?: string;
    };
  }>(
    "/api/public/municipalities/:tenantId/availability-search",
    {
      onRequest: limit,
      schema: {
        operationId: "publicAvailabilitySearch",
        description:
          "Busca unidades con intervalos completos libres. Cada página examina hasta 20 unidades publicadas; una página vacía puede tener continuación.",
        tags: ["Public catalog"],
        security: [],
        params: params(),
        querystring: {
          type: "object",
          additionalProperties: false,
          required: ["date", "durationMinutes"],
          properties: {
            date: { type: "string", format: "date" },
            durationMinutes: { type: "string", pattern: "^[1-9][0-9]{0,9}$" },
            after: uuid,
            facilityId: uuid,
          },
        },
        response: {
          ...errors,
          200: page({
            id: uuid,
            name: text,
            facilityId: uuid,
            facilityName: text,
            ...availabilityResponse.properties,
          }),
        },
      },
    },
    (request) =>
      publicAvailabilitySearch(
        pool,
        request.params.tenantId,
        request.query.date,
        Number(request.query.durationMinutes),
        request.query.after ?? null,
        undefined,
        request.query.facilityId ?? null,
      ),
  );
  app.get<{ Params: { tenantId: string }; Querystring: { after?: string } }>(
    "/api/public/municipalities/:tenantId/facilities",
    {
      onRequest: limit,
      schema: {
        operationId: "publicFacilities",
        tags: ["Public catalog"],
        security: [],
        params: params(),
        querystring: query,
        response: {
          ...errors,
          200: page({
            id: uuid,
            name: text,
            units: { type: "integer" },
            profile: facilityProfileSchema,
          }),
        },
      },
    },
    (request) =>
      publicFacilities(
        pool,
        request.params.tenantId,
        request.query.after ?? null,
      ),
  );
  app.get<{
    Params: { tenantId: string; facilityId: string };
    Querystring: { after?: string };
  }>(
    "/api/public/municipalities/:tenantId/facilities/:facilityId/units",
    {
      onRequest: limit,
      schema: {
        operationId: "publicUnits",
        tags: ["Public catalog"],
        security: [],
        params: params({ facilityId: uuid }),
        querystring: query,
        response: {
          ...errors,
          200: page({
            id: uuid,
            name: text,
            facilityId: uuid,
            minimumMinutes: { type: "integer" },
            maximumMinutes: { type: "integer" },
            profile: unitProfileSchema,
          }),
        },
      },
    },
    (request) =>
      publicUnits(
        pool,
        request.params.tenantId,
        request.params.facilityId,
        request.query.after ?? null,
      ),
  );
  app.get<{ Params: { tenantId: string; unitId: string } }>(
    "/api/public/municipalities/:tenantId/units/:unitId",
    {
      onRequest: limit,
      schema: {
        operationId: "publicUnitCalendar",
        description:
          "Devuelve el calendario y las versiones vigentes de normas y condiciones de cancelación. La reserva debe aceptar esas versiones; el servidor rechaza la operación si cambian antes de confirmarla.",
        tags: ["Public catalog"],
        security: [],
        params: params({ unitId: uuid }),
        response: {
          ...errors,
          200: {
            type: "object",
            additionalProperties: false,
            required: [
              "id",
              "name",
              "facilityId",
              "facilityName",
              "timeZone",
              "municipalAdvanceDays",
              "cancellationMinutes",
              "bookingPolicyVersion",
              "usageRulesVersion",
              "calendarVersion",
              "calendar",
              "profile",
              "facilityProfile",
            ],
            properties: {
              id: uuid,
              name: text,
              facilityId: uuid,
              facilityName: text,
              timeZone: text,
              municipalAdvanceDays: { type: "integer" },
              cancellationMinutes: { type: "integer" },
              bookingPolicyVersion: { type: "integer", minimum: 1 },
              usageRulesVersion: { type: "integer", minimum: 1 },
              calendarVersion: { type: "integer" },
              calendar: calendarSchema,
              profile: unitProfileSchema,
              facilityProfile: facilityProfileSchema,
            },
          },
        },
      },
    },
    (request) =>
      publicUnitCalendar(pool, request.params.tenantId, request.params.unitId),
  );

  app.get<{
    Params: { tenantId: string; unitId: string };
    Querystring: { date: string; durationMinutes: string };
  }>(
    "/api/public/municipalities/:tenantId/units/:unitId/availability",
    {
      onRequest: limit,
      schema: {
        operationId: "publicAvailability",
        description:
          "Consulta franjas libres según calendario y ocupaciones no liberadas en una misma transacción. No expone reservas ni titulares y no garantiza disponibilidad al confirmar una reserva.",
        tags: ["Public catalog"],
        security: [],
        params: params({ unitId: uuid }),
        querystring: {
          type: "object",
          additionalProperties: false,
          required: ["date", "durationMinutes"],
          properties: {
            date: { type: "string", format: "date" },
            durationMinutes: { type: "string", pattern: "^[1-9][0-9]{0,9}$" },
          },
        },
        response: { ...errors, 200: availabilityResponse },
      },
    },
    (request) =>
      publicAvailability(
        pool,
        request.params.tenantId,
        request.params.unitId,
        request.query.date,
        Number(request.query.durationMinutes),
      ),
  );
}

export const availabilityResponse = {
  type: "object",
  additionalProperties: false,
  required: [
    "unitId",
    "date",
    "timeZone",
    "calendarVersion",
    "calculatedAt",
    "slots",
  ],
  properties: {
    unitId: uuid,
    date: { type: "string", format: "date" },
    timeZone: text,
    calendarVersion: { type: "integer" },
    calculatedAt: { type: "string", format: "date-time" },
    slots: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["start", "end", "durationMinutes"],
        properties: {
          start: instant,
          end: instant,
          durationMinutes: { type: "integer" },
        },
      },
    },
  },
};
