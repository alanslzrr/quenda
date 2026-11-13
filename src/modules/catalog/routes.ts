import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { defaultIdempotencyRetentionSeconds } from "../../config.ts";
import {
  type AuthConfiguration,
  type Authentication,
  createRequestActor,
} from "../identity/index.ts";
import { registerCalendarRoutes } from "./calendar-routes.ts";
import { createFacility, createReservableUnit } from "./drafts.ts";
import { exportCatalog } from "./export.ts";
import { catalogExportExample, catalogExportSchema } from "./export-schema.ts";
import { type CatalogDocument, importCatalog } from "./import.ts";
import {
  inspectCatalogResource,
  renameCatalogResource,
} from "./maintenance.ts";
import { photoListSchema, registerCatalogPhotoRoutes } from "./photo-routes.ts";
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
const creationHeaders = {
  type: "object",
  properties: {
    "idempotency-key": { type: "string", pattern: "^[A-Za-z0-9._:-]{1,200}$" },
  },
};
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
  retentionSeconds = defaultIdempotencyRetentionSeconds,
) {
  const actor = createRequestActor(pool, auth, config);
  await registerCalendarRoutes(app, pool, auth, config);
  await registerUsageRulesRoutes(app, pool, auth, config);
  await registerPublicCatalog(app, pool, config.secret);
  await registerCatalogPhotoRoutes(app, pool, auth, config);
  app.post<{
    Headers: { "idempotency-key"?: string };
    Params: { tenantId: string };
    Body: { name: string };
  }>(
    "/api/municipalities/:tenantId/facilities",
    {
      schema: {
        operationId: "createFacility",
        headers: creationHeaders,
        tags: ["Catalog"],
        security: [{ quendaSession: [] }],
        description:
          "Alta administrativa de una instalación en borrador. No la publica. Idempotency-Key permite recuperar el resultado sin duplicar el alta dentro del plazo publicado; sin cabecera se crea una solicitud nueva.",
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
            request.headers["idempotency-key"],
            retentionSeconds,
          ),
        ),
  );
  app.post<{
    Headers: { "idempotency-key"?: string };
    Params: { tenantId: string; facilityId: string };
    Body: { name: string };
  }>(
    "/api/municipalities/:tenantId/facilities/:facilityId/units",
    {
      schema: {
        operationId: "createReservableUnit",
        headers: creationHeaders,
        tags: ["Catalog"],
        security: [{ quendaSession: [] }],
        description:
          "Alta administrativa de una unidad en borrador. No habilita reservas ni publicación. Idempotency-Key evita altas duplicadas dentro del plazo publicado; cada repetición comprueba el permiso actual.",
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
            request.headers["idempotency-key"],
            retentionSeconds,
          ),
        ),
  );
  app.post<{
    Params: { tenantId: string };
    Querystring: { settings?: "include" };
    Headers: { "idempotency-key"?: string };
    Body: CatalogDocument;
  }>(
    "/api/municipalities/:tenantId/imports/catalog",
    {
      schema: {
        operationId: "importCatalog",
        tags: ["Catalog"],
        security: [{ quendaSession: [] }],
        description:
          "Carga un documento quenda.catalog v1 (el de la exportación, de este u otro municipio o instancia) en un municipio sin instalaciones. Crea instalaciones y unidades en borrador con identificadores nuevos, sus fichas, calendario y normas, con auditoría. No importa recursos retirados, estado de publicación, reservas ni datos personales. Con settings=include aplica además la política de reserva y la apariencia del documento, como versiones nuevas auditadas, antes de comprobar los calendarios; los valores ya iguales no cambian. Exige administración del municipio, MFA reciente y Origin autorizado. Con instalaciones ya creadas responde 409. Idempotency-Key permite recuperar el resultado sin duplicar la importación.",
        params: {
          type: "object",
          additionalProperties: false,
          required: ["tenantId"],
          properties: { tenantId: uuid },
        },
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { settings: { type: "string", enum: ["include"] } },
        },
        headers: creationHeaders,
        body: catalogExportSchema,
        response: {
          ...errors,
          200: {
            type: "object",
            additionalProperties: false,
            required: [
              "tenantId",
              "facilities",
              "units",
              "calendars",
              "usageRules",
              "skippedWithdrawn",
              "settings",
            ],
            properties: {
              tenantId: uuid,
              facilities: { type: "integer", minimum: 0 },
              units: { type: "integer", minimum: 0 },
              calendars: { type: "integer", minimum: 0 },
              usageRules: { type: "integer", minimum: 0 },
              skippedWithdrawn: { type: "integer", minimum: 0 },
              settings: {
                type: "object",
                additionalProperties: false,
                required: ["bookingPolicy", "appearance"],
                properties: {
                  bookingPolicy: { type: "boolean" },
                  appearance: { type: "boolean" },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) =>
      reply
        .header("cache-control", "no-store")
        .send(
          await importCatalog(
            pool,
            await actor(request, reply),
            request.params.tenantId,
            request.body,
            request.headers["idempotency-key"],
            retentionSeconds,
            request.query.settings === "include",
          ),
        ),
  );
  app.get<{ Params: { tenantId: string } }>(
    "/api/municipalities/:tenantId/exports/catalog",
    {
      schema: {
        operationId: "exportCatalog",
        tags: ["Catalog"],
        security: [{ quendaSession: [] }],
        description:
          "JSON quenda.catalog v1: ajustes del municipio, instalaciones y unidades con su ficha, calendario vigente, normas vigentes y estado de publicación. No incluye reservas ni datos personales. Exige administración del municipio y MFA reciente. Sirve para archivo, auditoría o traslado: importCatalog lo carga en un municipio sin instalaciones.",
        params: {
          type: "object",
          additionalProperties: false,
          required: ["tenantId"],
          properties: { tenantId: uuid },
        },
        response: {
          ...errors,
          200: { ...catalogExportSchema, example: catalogExportExample },
        },
      },
    },
    async (request, reply) => {
      const document = await exportCatalog(
        pool,
        await actor(request, reply),
        request.params.tenantId,
      );
      return reply
        .header("cache-control", "no-store")
        .header(
          "content-disposition",
          'attachment; filename="quenda-catalog-v1.json"',
        )
        .send(document);
    },
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
        required: [
          ...response[200].required,
          "profile",
          "profileVersion",
          "photos",
        ],
        properties: {
          ...response[200].properties,
          profile: profileSchema,
          profileVersion: { type: "integer", minimum: 1 },
          photos: photoListSchema,
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
