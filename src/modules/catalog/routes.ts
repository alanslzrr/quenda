import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import {
  type AuthConfiguration,
  type Authentication,
  createRequestActor,
} from "../identity/index.ts";
import { createFacility, createReservableUnit } from "./drafts.ts";
import {
  inspectCatalogResource,
  renameCatalogResource,
} from "./maintenance.ts";

const uuid = { type: "string", format: "uuid" } as const;
const body = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: { name: { type: "string", minLength: 1, maxLength: 200 } },
} as const;
const errors = Object.fromEntries(
  [400, 401, 403, 404, 429, 500, 503].map((status) => [
    status,
    { $ref: "ErrorResponse#" },
  ]),
);
export async function registerCatalog(
  app: FastifyInstance,
  pool: Pool,
  auth: Authentication,
  config: AuthConfiguration,
) {
  const actor = createRequestActor(pool, auth, config);
  app.post<{ Params: { tenantId: string }; Body: { name: string } }>(
    "/api/municipalities/:tenantId/facilities",
    {
      schema: {
        operationId: "createFacility",
        tags: ["Catalog"],
        security: [{ quendaSession: [] }],
        description:
          "Alta administrativa de una instalación en borrador. No la publica.",
        params: {
          type: "object",
          additionalProperties: false,
          required: ["tenantId"],
          properties: { tenantId: uuid },
        },
        body,
        response: {
          ...errors,
          201: {
            type: "object",
            additionalProperties: false,
            required: ["tenantId", "facilityId", "name"],
            properties: {
              tenantId: uuid,
              facilityId: uuid,
              name: { type: "string" },
            },
          },
        },
      },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(
          await createFacility(
            pool,
            await actor(request, reply),
            request.params.tenantId,
            request.body,
          ),
        ),
  );
  app.post<{
    Params: { tenantId: string; facilityId: string };
    Body: { name: string };
  }>(
    "/api/municipalities/:tenantId/facilities/:facilityId/units",
    {
      schema: {
        operationId: "createReservableUnit",
        tags: ["Catalog"],
        security: [{ quendaSession: [] }],
        description:
          "Alta administrativa de una unidad en borrador. No habilita reservas ni publicación.",
        params: {
          type: "object",
          additionalProperties: false,
          required: ["tenantId", "facilityId"],
          properties: { tenantId: uuid, facilityId: uuid },
        },
        body,
        response: {
          ...errors,
          201: {
            type: "object",
            additionalProperties: false,
            required: ["tenantId", "facilityId", "unitId", "name"],
            properties: {
              tenantId: uuid,
              facilityId: uuid,
              unitId: uuid,
              name: { type: "string" },
            },
          },
        },
      },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(
          await createReservableUnit(
            pool,
            await actor(request, reply),
            request.params.tenantId,
            request.params.facilityId,
            request.body,
          ),
        ),
  );
  for (const kind of ["facility", "unit"] as const) {
    const resource = kind === "facility" ? "facilities" : "units";
    const params = {
      type: "object",
      additionalProperties: false,
      required: ["tenantId", "id"],
      properties: { tenantId: uuid, id: uuid },
    };
    const response = {
      ...errors,
      200: {
        type: "object",
        additionalProperties: false,
        required: ["tenantId", "id", "name"],
        properties: { tenantId: uuid, id: uuid, name: { type: "string" } },
      },
    };
    app.get<{ Params: { tenantId: string; id: string } }>(
      `/api/municipalities/:tenantId/${resource}/:id`,
      {
        schema: {
          operationId: `inspect_${kind}`,
          tags: ["Catalog"],
          security: [{ quendaSession: [] }],
          params,
          response,
        },
      },
      async (request, reply) =>
        inspectCatalogResource(
          pool,
          await actor(request, reply),
          request.params.tenantId,
          kind,
          request.params.id,
        ),
    );
    app.patch<{
      Params: { tenantId: string; id: string };
      Body: { name: string };
    }>(
      `/api/municipalities/:tenantId/${resource}/:id`,
      {
        schema: {
          operationId: `rename_${kind}`,
          tags: ["Catalog"],
          security: [{ quendaSession: [] }],
          params,
          body,
          response,
        },
      },
      async (request, reply) =>
        renameCatalogResource(
          pool,
          await actor(request, reply),
          request.params.tenantId,
          kind,
          request.params.id,
          request.body.name,
        ),
    );
  }
}
