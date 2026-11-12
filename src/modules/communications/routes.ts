import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import {
  type AuthConfiguration,
  type Authentication,
  createRequestActor,
} from "../identity/index.ts";
import { registerAnalyticsSettingsRoutes } from "./analytics-settings-routes.ts";
import { registerExportRoutes } from "./export-routes.ts";
import { registerIndicatorRoutes } from "./indicator-routes.ts";
import { listOwnNotices } from "./notices.ts";

export async function registerCommunications(
  app: FastifyInstance,
  pool: Pool,
  auth: Authentication,
  config: AuthConfiguration,
) {
  await registerIndicatorRoutes(app, pool, auth, config);
  await registerAnalyticsSettingsRoutes(app, pool, auth, config);
  await registerExportRoutes(app, pool, auth, config);
  const actor = createRequestActor(pool, auth, config);
  const uuid = { type: "string", format: "uuid" },
    instant = { type: "string", format: "date-time" };
  const properties = {
    eventId: uuid,
    tenantId: uuid,
    reservationId: uuid,
    unitId: uuid,
    revision: { type: "integer", minimum: 1 },
    kind: { type: "string", enum: ["CONFIRMADA", "MODIFICADA", "CANCELADA"] },
    occurredAt: instant,
    administrative: { type: "boolean" },
    actorName: { type: "string", nullable: true },
    reason: { type: "string", nullable: true },
    startsAt: instant,
    endsAt: instant,
    timeZone: { type: "string" },
    pendingUsageRulesVersion: {
      type: "integer",
      minimum: 1,
      nullable: true,
    },
    reservationPath: { type: "string" },
  };
  app.get<{ Querystring: { after?: string } }>(
    "/api/me/notices",
    {
      schema: {
        operationId: "ownReservationNotices",
        tags: ["Communications"],
        security: [{ quendaSession: [] }],
        description:
          "Avisos internos del usuario entre municipios. Páginas de 20 por identificador de evento y municipio, no por fecha. Cada aviso describe el evento histórico y enlaza al estado actual; no representa el estado del correo. pendingUsageRulesVersion identifica las normas de unitId pendientes de aceptación en ese evento, no una aceptación ni el estado actual. Las intervenciones administrativas incluyen el nombre capturado del autor (nulo para eventos históricos sin captura), el motivo y la fecha. No expone identificadores de cuenta ni correlación.",
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { after: { type: "string", maxLength: 73 } },
        },
        response: {
          ...Object.fromEntries(
            [400, 401, 403, 429, 500, 503].map((status) => [
              status,
              { $ref: "ErrorResponse#" },
            ]),
          ),
          200: {
            type: "object",
            additionalProperties: false,
            required: ["items", "nextCursor"],
            properties: {
              items: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: Object.keys(properties),
                  properties,
                },
              },
              nextCursor: { type: "string", nullable: true },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const account = await actor(request, reply);
      return reply
        .header("cache-control", "no-store")
        .send(await listOwnNotices(pool, account, request.query.after ?? null));
    },
  );
}
