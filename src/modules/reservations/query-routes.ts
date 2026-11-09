import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { language } from "../../http/errors.ts";
import {
  type AuthConfiguration,
  type Authentication,
  createRequestActor,
} from "../identity/index.ts";
import { acceptanceProperties } from "./acceptance.ts";
import { reservationCalendar, upcomingCalendar } from "./personal-calendar.ts";
import {
  listMunicipalReservations,
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
            ? "Reservas del usuario autenticado entre municipios de esta instancia, incluidas unidades retiradas. tenantId filtra un municipio sin ampliar el acceso. Páginas de 20, orden estable por ID y municipio. Mantener el filtro al continuar con nextCursor; al cambiarlo, iniciar sin cursor. El cursor no identifica otro usuario."
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
              ? { after: { type: "string", maxLength: 73 }, tenantId: uuid }
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
  const calendarResponse = (summary: string) => ({
    ...Object.fromEntries(
      [400, 401, 403, 404, 429, 500, 503].map((status) => [
        status,
        { $ref: "ErrorResponse#" },
      ]),
    ),
    200: {
      description: summary,
      content: { "text/calendar": { schema: { type: "string" } } },
    },
  });
  const attachment = (reply: import("fastify").FastifyReply, name: string) =>
    reply
      .header("cache-control", "no-store")
      .header("content-type", "text/calendar; charset=utf-8")
      .header("content-disposition", `attachment; filename="${name}"`);
  const lang = {
    type: "object",
    additionalProperties: false,
    properties: { lang: { type: "string", enum: ["es", "gl"] } },
  } as const;
  app.get<{ Querystring: { lang?: "es" | "gl" } }>(
    "/api/me/reservations/calendar.ics",
    {
      schema: {
        operationId: "ownReservationsCalendar",
        tags: ["Reservations"],
        security: [{ quendaSession: [] }],
        description:
          "Archivo iCalendar (RFC 5545) con las próximas reservas confirmadas de la cuenta, hasta 100, de la más cercana a la más lejana. Las horas van en UTC; cada reserva tiene un UID estable y SEQUENCE igual a su revisión, de modo que volver a importar el archivo actualiza en vez de duplicar. El idioma del texto sigue a lang (es o gl) o, si falta, a Accept-Language. Es una descarga puntual: no crea enlaces de suscripción ni secretos.",
        querystring: lang,
        response: calendarResponse("Calendario con las próximas reservas"),
      },
    },
    async (request, reply) => {
      const account = await actor(request, reply);
      return attachment(reply, "quenda-proximas-reservas.ics").send(
        await upcomingCalendar(
          pool,
          account,
          config.origin,
          request.query.lang ?? language(request.headers["accept-language"]),
        ),
      );
    },
  );
  app.get<{
    Params: { tenantId: string; reservationId: string };
    Querystring: { lang?: "es" | "gl" };
  }>(
    "/api/municipalities/:tenantId/reservations/:reservationId/calendar.ics",
    {
      schema: {
        operationId: "reservationCalendar",
        tags: ["Reservations"],
        security: [{ quendaSession: [] }],
        description:
          "Archivo iCalendar (RFC 5545) de una reserva del titular, en cualquier estado. Una reserva cancelada se publica con STATUS:CANCELLED y el mismo UID, para que el calendario retire el evento. Solo el titular puede descargarlo; otra cuenta recibe 404.",
        params: {
          type: "object",
          additionalProperties: false,
          required: ["tenantId", "reservationId"],
          properties: { tenantId: uuid, reservationId: uuid },
        },
        querystring: lang,
        response: calendarResponse("Calendario con la reserva"),
      },
    },
    async (request, reply) => {
      const account = await actor(request, reply);
      return attachment(
        reply,
        `quenda-reserva-${request.params.reservationId.slice(0, 8)}.ics`,
      ).send(
        await reservationCalendar(
          pool,
          account,
          request.params.tenantId,
          request.params.reservationId,
          config.origin,
          request.query.lang ?? language(request.headers["accept-language"]),
        ),
      );
    },
  );
}
