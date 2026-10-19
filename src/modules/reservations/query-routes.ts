import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import {
  type AuthConfiguration,
  type Authentication,
  createRequestActor,
} from "../identity/index.ts";
import { listMunicipalReservations, listOwnReservations } from "./queries.ts";

export async function registerReservationQueries(
  app: FastifyInstance,
  pool: Pool,
  auth: Authentication,
  config: AuthConfiguration,
) {
  const actor = createRequestActor(pool, auth, config);
  const uuid = { type: "string", format: "uuid" },
    instant = { type: "string", format: "date-time" };
  for (const own of [true, false]) {
    const extra = own
      ? { municipality: { type: "string" }, unitName: { type: "string" } }
      : { accountId: { type: "string" } };
    app.get<{
      Params: { tenantId: string };
      Querystring: { after?: string; unitId?: string };
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
            ? "Reservas del usuario autenticado entre municipios de esta instancia, incluidas unidades retiradas. Páginas de 20, orden estable por ID y municipio. El cursor no identifica otro usuario."
            : "Reservas del municipio incluidas en los permisos RESERVATION_READ o RESERVATION_MANAGE. Requiere MFA. Páginas de 20 por ID; unitId filtra una unidad sin ampliar permisos.",
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
              ? { after: { type: "string", maxLength: 73 } }
              : { after: uuid, unitId: uuid },
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
          ? listOwnReservations(pool, account, request.query.after ?? null)
          : listMunicipalReservations(
              pool,
              account,
              request.params.tenantId,
              request.query,
            );
      },
    );
  }
}
