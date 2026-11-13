import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import {
  type AuthConfiguration,
  type Authentication,
  createRequestActor,
  createSessionReader,
} from "../identity/index.ts";
import { registerAnalyticsSettingsRoutes } from "./analytics-settings-routes.ts";
import { registerExportRoutes } from "./export-routes.ts";
import { registerIndicatorRoutes } from "./indicator-routes.ts";
import {
  countUnreadNotices,
  listOwnNotices,
  noticeCursorMaxLength,
  readOwnNotices,
} from "./notices.ts";

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
  const session = createSessionReader(auth);
  const uuid = { type: "string", format: "uuid" },
    instant = { type: "string", format: "date-time" };
  const properties = {
    eventId: uuid,
    tenantId: uuid,
    reservationId: uuid,
    unitId: uuid,
    municipality: { type: "string" },
    unitName: { type: "string", nullable: true },
    facilityName: { type: "string", nullable: true },
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
    readAt: { ...instant, nullable: true },
    reservationPath: { type: "string" },
  };
  const failures = (codes: number[]) =>
    Object.fromEntries(
      codes.map((status) => [status, { $ref: "ErrorResponse#" }]),
    );
  app.get<{ Querystring: { after?: string } }>(
    "/api/me/notices",
    {
      schema: {
        operationId: "ownReservationNotices",
        tags: ["Communications"],
        security: [{ quendaSession: [] }],
        description:
          "Avisos internos del usuario entre municipios, del más reciente al más antiguo. Páginas de 20; after acepta el nextCursor anterior. Cada aviso nombra el municipio, el espacio y la instalación actuales (nulos si ya no existen), e indica en readAt cuándo lo leyó su titular (nulo si está sin leer). Cada aviso describe el evento histórico y enlaza al estado actual; no representa el estado del correo. pendingUsageRulesVersion identifica las normas de unitId pendientes de aceptación en ese evento, no una aceptación ni el estado actual. Las intervenciones administrativas incluyen el nombre capturado del autor (nulo para eventos históricos sin captura), el motivo y la fecha. No expone identificadores de cuenta ni correlación.",
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            after: { type: "string", maxLength: noticeCursorMaxLength },
          },
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
  app.get(
    "/api/me/notices/unread",
    {
      schema: {
        operationId: "ownUnreadNoticeCount",
        tags: ["Communications"],
        security: [{ quendaSession: [] }],
        description:
          "Número de avisos del usuario autenticado que aún no ha leído, para el contador del menú. Como GET /api/me, solo lee el estado de la propia cuenta y no consume el límite de peticiones administrativas, porque la interfaz lo consulta en cada página.",
        response: {
          ...failures([401, 500, 503]),
          200: {
            type: "object",
            additionalProperties: false,
            required: ["unread"],
            properties: { unread: { type: "integer", minimum: 0 } },
          },
        },
      },
    },
    async (request, reply) => {
      const account = await session(request);
      return reply
        .header("cache-control", "no-store")
        .send(await countUnreadNotices(pool, account));
    },
  );
  app.post(
    "/api/me/notices/read",
    {
      schema: {
        operationId: "readAllOwnNotices",
        tags: ["Communications"],
        security: [{ quendaSession: [] }],
        description:
          "Marca como leídos todos los avisos sin leer del usuario autenticado. read indica cuántos cambiaron; los ya leídos conservan su fecha de lectura. Requiere Origin autorizado.",
        response: {
          ...failures([401, 403, 429, 500, 503]),
          200: {
            type: "object",
            additionalProperties: false,
            required: ["read"],
            properties: { read: { type: "integer", minimum: 0 } },
          },
        },
      },
    },
    async (request, reply) => readOwnNotices(pool, await actor(request, reply)),
  );
  app.post<{ Params: { tenantId: string; eventId: string } }>(
    "/api/me/notices/:tenantId/:eventId/read",
    {
      schema: {
        operationId: "readOwnNotice",
        tags: ["Communications"],
        security: [{ quendaSession: [] }],
        description:
          "Marca como leído un aviso del usuario autenticado. read es 1 si estaba sin leer y 0 si ya estaba leído o no es suyo, sin distinguir ambos casos. Requiere Origin autorizado.",
        params: {
          type: "object",
          additionalProperties: false,
          required: ["tenantId", "eventId"],
          properties: { tenantId: uuid, eventId: uuid },
        },
        response: {
          ...failures([400, 401, 403, 429, 500, 503]),
          200: {
            type: "object",
            additionalProperties: false,
            required: ["read"],
            properties: { read: { type: "integer", minimum: 0, maximum: 1 } },
          },
        },
      },
    },
    async (request, reply) =>
      readOwnNotices(pool, await actor(request, reply), request.params),
  );
}
