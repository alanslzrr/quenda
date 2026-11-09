import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import {
  type AuthConfiguration,
  type Authentication,
  createRequestActor,
} from "../identity/index.ts";
import { acceptanceProperties } from "./acceptance.ts";
import {
  listMunicipalReservations,
  listOwnReservationMunicipalities,
  listOwnReservations,
  readReservation,
} from "./queries.ts";

export async function registerReservationQueries(
  app: FastifyInstance,
  pool: Pool,
  auth: Authentication,
  config: AuthConfiguration,
) {
  const actor = createRequestActor(pool, auth, config);
  const uuid = { type: "string", format: "uuid" },
    instant = { type: "string", format: "date-time" };
  app.get<{ Params: { tenantId: string; reservationId: string } }>(
    "/api/municipalities/:tenantId/reservations/:reservationId",
    {
      schema: {
        operationId: "readReservation",
        tags: ["Reservations"],
        security: [{ quendaSession: [] }],
        description:
          "Estado actual de una reserva, independiente de resultados idempotentes anteriores. Acceso del titular o personal con RESERVATION_READ/MANAGE sobre la unidad y MFA. Conserva acceso a reservas de recursos retirados.",
        params: {
          type: "object",
          additionalProperties: false,
          required: ["tenantId", "reservationId"],
          properties: { tenantId: uuid, reservationId: uuid },
        },
        response: {
          ...Object.fromEntries(
            [400, 401, 403, 404, 429, 500, 503].map((status) => [
              status,
              { $ref: "ErrorResponse#" },
            ]),
          ),
          200: {
            type: "object",
            additionalProperties: false,
            required: [
              "id",
              "tenantId",
              "accountId",
              "usageRulesText",
              "pendingUsageRulesText",
              "unitId",
              "startsAt",
              "endsAt",
              "status",
              "revision",
              "calendarVersion",
              "cancellationMinutes",
              "timeZone",
              ...Object.keys(acceptanceProperties),
            ],
            properties: {
              id: uuid,
              tenantId: uuid,
              accountId: { type: "string" },
              usageRulesText: { type: "string", nullable: true },
              pendingUsageRulesText: { type: "string", nullable: true },
              unitId: uuid,
              startsAt: instant,
              endsAt: instant,
              status: {
                type: "string",
                enum: ["CONFIRMADA", "CANCELADA", "FINALIZADA"],
              },
              revision: { type: "integer" },
              calendarVersion: { type: "integer" },
              cancellationMinutes: { type: "integer" },
              timeZone: { type: "string" },
              ...acceptanceProperties,
            },
          },
        },
      },
    },
    async (request, reply) => {
      const account = await actor(request, reply);
      reply.header("cache-control", "no-store");
      return readReservation(
        pool,
        account,
        request.params.tenantId,
        request.params.reservationId,
        undefined,
        request.id,
      );
    },
  );
  for (const own of [true, false]) {
    const extra = own
      ? { municipality: { type: "string" }, unitName: { type: "string" } }
      : { accountId: { type: "string" } };
    app.get<{
      Params: { tenantId: string };
      Querystring: {
        after?: string;
        unitId?: string;
        tenantId?: string;
        date?: string;
      };
    }>(
      own
        ? "/api/me/reservations"
        : "/api/municipalities/:tenantId/reservations",
      {
        schema: {
          operationId: own ? "ownReservations" : "municipalReservations",
          tags: ["Reservations"],
          security: [{ quendaSession: [] }],
          description: own
            ? "Reservas del usuario autenticado entre municipios de esta instancia, incluidas unidades retiradas. tenantId filtra un municipio sin ampliar el acceso. Páginas de 20, de la más reciente a la más antigua por inicio, con desempate estable por ID y municipio. nextCursor codifica esa clave completa (inicio|ID|municipio) y es opaco para el cliente: mantener el filtro al continuar con él y, al cambiarlo, iniciar sin cursor. Un cursor con otro formato se rechaza con 400. El cursor no identifica otro usuario."
            : "Reservas del municipio incluidas en los permisos RESERVATION_READ o RESERVATION_MANAGE. Requiere MFA. Páginas de 20 por ID; unitId filtra una unidad sin ampliar permisos. date selecciona intervalos que se solapan con ese día en la zona municipal antes de paginar; incluye reservas canceladas.",
          ...(!own
            ? {
                params: {
                  type: "object",
                  additionalProperties: false,
                  required: ["tenantId"],
                  properties: { tenantId: uuid },
                },
              }
            : {}),
          querystring: {
            type: "object",
            additionalProperties: false,
            properties: own
              ? { after: { type: "string", maxLength: 128 }, tenantId: uuid }
              : {
                  after: uuid,
                  unitId: uuid,
                  date: { type: "string", format: "date" },
                },
          },
          response: {
            ...Object.fromEntries(
              [400, 401, 403, 429, 500, 503].map((s) => [
                s,
                { $ref: "ErrorResponse#" },
              ]),
            ),
            200: {
              type: "object",
              additionalProperties: false,
              required: ["items", "nextCursor"],
              properties: {
                nextCursor: { type: "string", nullable: true },
                items: {
                  type: "array",
                  maxItems: 20,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: [
                      "id",
                      "tenantId",
                      "unitId",
                      "startsAt",
                      "endsAt",
                      "status",
                      "revision",
                      "calendarVersion",
                      "cancellationMinutes",
                      "timeZone",
                      ...Object.keys(acceptanceProperties),
                      ...Object.keys(extra),
                    ],
                    properties: {
                      id: uuid,
                      tenantId: uuid,
                      unitId: uuid,
                      startsAt: instant,
                      endsAt: instant,
                      status: {
                        type: "string",
                        enum: ["CONFIRMADA", "CANCELADA", "FINALIZADA"],
                      },
                      revision: { type: "integer" },
                      calendarVersion: { type: "integer" },
                      cancellationMinutes: { type: "integer" },
                      timeZone: { type: "string" },
                      ...acceptanceProperties,
                      ...extra,
                    },
                  },
                },
              },
            },
          },
        },
      },
      async (request, reply) => {
        const account = await actor(request, reply);
        reply.header("cache-control", "no-store");
        return own
          ? listOwnReservations(pool, account, request.query)
          : listMunicipalReservations(
              pool,
              account,
              request.params.tenantId,
              request.query,
              undefined,
              request.id,
            );
      },
    );
  }
  app.get<{ Querystring: { after?: string } }>(
    "/api/me/reservations/municipalities",
    {
      schema: {
        operationId: "ownReservationMunicipalities",
        tags: ["Reservations"],
        security: [{ quendaSession: [] }],
        description:
          "Municipios en los que la cuenta autenticada tiene reservas, para filtrar su historial. No es un directorio: solo refleja la huella de la propia cuenta, sin ampliar el acceso. Páginas de 20 ordenadas por ID de municipio; nextCursor es el último ID devuelto.",
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { after: uuid },
        },
        response: {
          ...Object.fromEntries(
            [400, 401, 403, 429, 500, 503].map((s) => [
              s,
              { $ref: "ErrorResponse#" },
            ]),
          ),
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
                  required: ["tenantId", "name"],
                  properties: { tenantId: uuid, name: { type: "string" } },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const account = await actor(request, reply);
      reply.header("cache-control", "no-store");
      return listOwnReservationMunicipalities(pool, account, request.query);
    },
  );
}
