import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { calendarSchema } from "./calendar-routes.ts";
import {
  publicAvailability,
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
        response: { ...errors, 200: page({ id: uuid, name: text }) },
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
          200: page({ id: uuid, name: text, facilityId: uuid }),
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
              "timeZone",
              "municipalAdvanceDays",
              "cancellationMinutes",
              "calendarVersion",
              "calendar",
            ],
            properties: {
              id: uuid,
              name: text,
              facilityId: uuid,
              timeZone: text,
              municipalAdvanceDays: { type: "integer" },
              cancellationMinutes: { type: "integer" },
              calendarVersion: { type: "integer" },
              calendar: calendarSchema,
            },
          },
        },
      },
    },
    (request) =>
      publicUnitCalendar(pool, request.params.tenantId, request.params.unitId),
  );

  const availabilityResponse = {
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
  app.get<{
    Params: { tenantId: string; unitId: string };
    Querystring: { date: string; durationMinutes: string };
  }>(
    "/api/public/municipalities/:tenantId/units/:unitId/availability",
    {
      onRequest: limit,
      schema: {
        operationId: "publicAvailability",
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
