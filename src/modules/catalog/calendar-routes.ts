import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import {
  type AuthConfiguration,
  type Authentication,
  createRequestActor,
} from "../identity/index.ts";
import type { UnitCalendarInput } from "./calendar.ts";
import { readUnitCalendar, saveUnitCalendar } from "./calendar-store.ts";

const integer = { type: "integer", maximum: 2147483647 } as const;
const interval = {
  type: "object",
  additionalProperties: false,
  required: ["startMinute", "endMinute"],
  properties: {
    startMinute: { ...integer, minimum: 0, maximum: 1439 },
    endMinute: { ...integer, minimum: 1, maximum: 1440 },
  },
} as const;
export const calendarSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "minimumMinutes",
    "maximumMinutes",
    "stepMinutes",
    "advanceDays",
    "weekly",
    "exceptions",
  ],
  properties: {
    minimumMinutes: { ...integer, minimum: 1 },
    maximumMinutes: { ...integer, minimum: 1 },
    stepMinutes: { ...integer, minimum: 1 },
    advanceDays: { ...integer, minimum: 0, nullable: true },
    weekly: {
      type: "array",
      items: {
        ...interval,
        required: ["day", "startMinute", "endMinute"],
        properties: {
          ...interval.properties,
          day: { ...integer, minimum: 1, maximum: 7 },
        },
      },
    },
    exceptions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["date", "intervals"],
        properties: {
          date: { type: "string", format: "date" },
          intervals: { type: "array", items: interval },
        },
      },
    },
  },
} as const;
export async function registerCalendarRoutes(
  app: FastifyInstance,
  pool: Pool,
  auth: Authentication,
  config: AuthConfiguration,
) {
  const actor = createRequestActor(pool, auth, config);
  const uuid = { type: "string", format: "uuid" };
  const params = {
    type: "object",
    additionalProperties: false,
    required: ["tenantId", "unitId"],
    properties: { tenantId: uuid, unitId: uuid },
  };
  const response = {
    ...Object.fromEntries(
      [400, 401, 403, 404, 409, 429, 500, 503].map((status) => [
        status,
        { $ref: "ErrorResponse#" },
      ]),
    ),
    200: {
      type: "object",
      additionalProperties: false,
      required: [
        "tenantId",
        "unitId",
        "version",
        "actorId",
        "reason",
        "createdAt",
        "calendar",
      ],
      properties: {
        tenantId: uuid,
        unitId: uuid,
        version: { ...integer, minimum: 1 },
        actorId: { type: "string" },
        reason: { type: "string" },
        createdAt: { type: "string", format: "date-time" },
        calendar: calendarSchema,
      },
    },
  };
  app.put<{
    Params: { tenantId: string; unitId: string };
    Body: {
      expectedVersion: number;
      reason: string;
      calendar: UnitCalendarInput;
    };
  }>(
    "/api/municipalities/:tenantId/units/:unitId/calendar",
    {
      schema: {
        operationId: "saveUnitCalendar",
        tags: ["Catalog"],
        security: [{ quendaSession: [] }],
        params,
        response,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["expectedVersion", "reason", "calendar"],
          properties: {
            expectedVersion: { ...integer, minimum: 0, maximum: 2147483646 },
            reason: { type: "string", minLength: 1, maxLength: 500 },
            calendar: calendarSchema,
          },
        },
      },
    },
    async (request, reply) =>
      saveUnitCalendar(
        pool,
        await actor(request, reply),
        request.params.tenantId,
        request.params.unitId,
        request.body,
      ),
  );
  app.get<{
    Params: { tenantId: string; unitId: string };
    Querystring: { version?: string };
  }>(
    "/api/municipalities/:tenantId/units/:unitId/calendar",
    {
      schema: {
        operationId: "readUnitCalendar",
        tags: ["Catalog"],
        security: [{ quendaSession: [] }],
        params,
        response,
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            version: { type: "string", pattern: "^[1-9][0-9]{0,9}$" },
          },
        },
      },
    },
    async (request, reply) =>
      readUnitCalendar(
        pool,
        await actor(request, reply),
        request.params.tenantId,
        request.params.unitId,
        request.query.version ? Number(request.query.version) : null,
      ),
  );
}
