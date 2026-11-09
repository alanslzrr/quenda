import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import {
  type AuthConfiguration,
  type Authentication,
  createRequestActor,
} from "../identity/index.ts";
import { registerCalendarRoutes } from "./calendar-routes.ts";
import { createFacility, createReservableUnit } from "./drafts.ts";
import {
  inspectCatalogResource,
  renameCatalogResource,
} from "./maintenance.ts";
import {
  type FacilityProfileInput,
  saveCatalogProfile,
  type UnitProfileInput,
} from "./profile.ts";
import {
  facilityProfileBody,
  facilityProfileSchema,
  unitProfileBody,
  unitProfileSchema,
} from "./profile-schema.ts";
import { registerPublicCatalog } from "./public-routes.ts";
import { publishCatalogResource } from "./publication.ts";
import { listCatalogResources } from "./queries.ts";
import { registerUsageRulesRoutes } from "./usage-rules-routes.ts";
import { withdrawCatalogResource } from "./withdrawal.ts";

const uuid = { type: "string", format: "uuid" } as const;
const body = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: { name: { type: "string", minLength: 1, maxLength: 200 } },
} as const;
const errors = Object.fromEntries(
  [400, 401, 403, 404, 409, 429, 500, 503].map((status) => [
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
  await registerCalendarRoutes(app, pool, auth, config);
  await registerUsageRulesRoutes(app, pool, auth, config);
  await registerPublicCatalog(app, pool, config.secret);
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

    app.get<{ Params: { tenantId: string }; Querystring: { after?: string } }>(
      `/api/municipalities/:tenantId/${resource}`,
      {
        schema: {
          operationId: `list_${kind}`,
          tags: ["Catalog"],
          security: [{ quendaSession: [] }],
          description:
            "Listado administrativo con MFA reciente. Devuelve únicamente recursos visibles según los permisos del actor; sin permisos devuelve una lista vacía. Hasta veinte por página. No publica borradores.",
          params: {
            type: "object",
            additionalProperties: false,
            required: ["tenantId"],
            properties: { tenantId: uuid },
          },
          querystring: {
            type: "object",
            additionalProperties: false,
            properties: { after: uuid },
          },
          response: {
            ...errors,
            200: {
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
                    required: ["id", "name", "facilityId"],
                    properties: {
                      id: uuid,
                      name: { type: "string" },
                      facilityId: uuid,
                      publishedAt: {
                        type: "string",
                        format: "date-time",
                        nullable: true,
                      },
                      withdrawnAt: {
                        type: "string",
                        format: "date-time",
                        nullable: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      async (request, reply) =>
        listCatalogResources(
          pool,
          await actor(request, reply),
          request.params.tenantId,
          kind,
          request.query.after ?? null,
        ),
    );
    const params = {
      type: "object",
      additionalProperties: false,
      required: ["tenantId", "id"],
      properties: { tenantId: uuid, id: uuid },
    };
    const profileSchema =
      kind === "facility" ? facilityProfileSchema : unitProfileSchema;
    const response = {
      ...errors,
      200: {
        type: "object",
        additionalProperties: false,
        required: ["tenantId", "id", "name"],
        properties: {
          tenantId: uuid,
          id: uuid,
          name: { type: "string" },
          publishedAt: { type: "string", format: "date-time", nullable: true },
          withdrawnAt: { type: "string", format: "date-time", nullable: true },
        },
      },
    };
    // Only the administrative read carries the profile; changes answer with the short form above.
    const inspected = {
      ...errors,
      200: {
        ...response[200],
        required: [...response[200].required, "profile", "profileVersion"],
        properties: {
          ...response[200].properties,
          profile: profileSchema,
          profileVersion: { type: "integer", minimum: 1 },
        },
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
          response: inspected,
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

    app.post<{
      Params: { tenantId: string; id: string };
      Body: { reason: string };
    }>(
      `/api/municipalities/:tenantId/${resource}/:id/withdraw`,
      {
        schema: {
          operationId: `withdraw_${kind}`,
          tags: ["Catalog"],
          security: [{ quendaSession: [] }],
          params,
          body: {
            type: "object",
            additionalProperties: false,
            required: ["reason"],
            properties: {
              reason: { type: "string", minLength: 1, maxLength: 500 },
            },
          },
          response: {
            ...errors,
            200: {
              type: "object",
              additionalProperties: false,
              required: ["tenantId", "id", "withdrawnAt"],
              properties: {
                tenantId: uuid,
                id: uuid,
                withdrawnAt: { type: "string", format: "date-time" },
              },
            },
          },
        },
      },
      async (request, reply) =>
        withdrawCatalogResource(
          pool,
          await actor(request, reply),
          request.params.tenantId,
          kind,
          request.params.id,
          request.body.reason,
        ),
    );

    app.post<{
      Params: { tenantId: string; id: string };
      Body: {
        reason: string;
        calendarVersion?: number;
        independenceConfirmed?: boolean;
      };
    }>(
      `/api/municipalities/:tenantId/${resource}/:id/publish`,
      {
        schema: {
          operationId: `publish_${kind}`,
          tags: ["Catalog"],
          security: [{ quendaSession: [] }],
          params,
          body: {
            type: "object",
            additionalProperties: false,
            required:
              kind === "unit"
                ? ["reason", "calendarVersion", "independenceConfirmed"]
                : ["reason"],
            properties: {
              reason: { type: "string", minLength: 1, maxLength: 500 },
              ...(kind === "unit"
                ? {
                    calendarVersion: {
                      type: "integer",
                      minimum: 1,
                      maximum: 2147483647,
                    },
                    independenceConfirmed: { type: "boolean", const: true },
                  }
                : {}),
            },
          },
          response: {
            ...errors,
            200: {
              type: "object",
              additionalProperties: false,
              required: ["tenantId", "id", "publishedAt"],
              properties: {
                tenantId: uuid,
                id: uuid,
                publishedAt: { type: "string", format: "date-time" },
              },
            },
          },
        },
      },
      async (request, reply) =>
        publishCatalogResource(
          pool,
          await actor(request, reply),
          request.params.tenantId,
          kind,
          request.params.id,
          request.body,
        ),
    );
    app.put<{
      Params: { tenantId: string; id: string };
      Body: FacilityProfileInput | UnitProfileInput;
    }>(
      `/api/municipalities/:tenantId/${resource}/:id/profile`,
      {
        schema: {
          operationId: `save_${kind}_profile`,
          tags: ["Catalog"],
          security: [{ quendaSession: [] }],
          description:
            "Sustituye la ficha completa: los campos ausentes se borran, de modo que leer, editar y reenviar es el flujo completo. Exige CATALOG_MANAGE sobre el recurso, MFA reciente y expectedVersion igual a profileVersion; una versión distinta devuelve CONFLICT. No publica nada. Cada cambio queda auditado.",
          params,
          body: kind === "facility" ? facilityProfileBody : unitProfileBody,
          response: {
            ...errors,
            200: {
              type: "object",
              additionalProperties: false,
              required: ["profile", "profileVersion"],
              properties: {
                profile: profileSchema,
                profileVersion: { type: "integer", minimum: 1 },
              },
            },
          },
        },
      },
      async (request, reply) =>
        saveCatalogProfile(
          pool,
          await actor(request, reply),
          request.params.tenantId,
          kind,
          request.params.id,
          request.body,
          request.id,
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
