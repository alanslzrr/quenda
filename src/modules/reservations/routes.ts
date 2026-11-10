import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import {
  type AuthConfiguration,
  type Authentication,
  createRequestActor,
} from "../identity/index.ts";
import { registerUsageRulesAcceptanceRoute } from "./accept-usage-rules-route.ts";
import { acceptanceProperties, acceptanceSchema } from "./acceptance.ts";
import { registerAgendaRoutes } from "./agenda-routes.ts";
import { registerReservationAvailability } from "./availability-routes.ts";
import { registerBlockRoutes } from "./block-routes.ts";
import { registerCalendarSubscriptionRoutes } from "./calendar-subscription-routes.ts";
import { registerCancellationRoute } from "./cancel-routes.ts";
import { type CreateReservationInput, createReservation } from "./create.ts";
import { registerModificationRoute } from "./modify-routes.ts";
import { registerReservationQueries } from "./query-routes.ts";

const uuid = { type: "string", format: "uuid" } as const;
const instant = { type: "string", format: "date-time" } as const;
export async function registerReservations(
  app: FastifyInstance,
  pool: Pool,
  auth: Authentication,
  config: AuthConfiguration,
  retentionSeconds: number,
) {
  await registerReservationAvailability(
    app,
    pool,
    auth,
    config,
    retentionSeconds,
  );
  await registerAgendaRoutes(app, pool, auth, config);
  const actor = createRequestActor(pool, auth, config);
  await registerReservationQueries(app, pool, auth, config);
  await registerCalendarSubscriptionRoutes(app, pool, auth, config);
  await registerBlockRoutes(app, pool, auth, config, retentionSeconds);
  await registerModificationRoute(app, pool, auth, config, retentionSeconds);
  await registerCancellationRoute(app, pool, auth, config, retentionSeconds);
  await registerUsageRulesAcceptanceRoute(
    app,
    pool,
    auth,
    config,
    retentionSeconds,
  );
  app.post<{
    Params: { tenantId: string };
    Headers: { "idempotency-key": string };
    Body: CreateReservationInput;
  }>(
    "/api/municipalities/:tenantId/reservations",
    {
      schema: {
        operationId: "createReservation",
        tags: ["Reservations"],
        security: [{ quendaSession: [] }],
        description: `Confirma una reserva del usuario autenticado. acceptance expresa la aceptación de versiones vigentes de normas y política y es obligatoria para crear una reserva nueva. Su omisión solo permite recuperar un comando anterior sin aceptación cuyo resultado siga retenido; no autoriza nuevas reservas y devuelve 409 CONDITIONS_ACCEPTANCE_REQUIRED si debe ejecutarse un alta. nonCancellable debe coincidir con el vencimiento del plazo al ejecutar; true reconoce que no podrá modificar ni cancelar por sí mismo. Versiones obsoletas requieren revisión; no se sustituyen silenciosamente. Idempotency-Key se delimita por usuario, municipio y operación; retención de esta instancia: ${retentionSeconds} segundos. Repetir clave y contenido recupera el resultado original sin duplicar efectos. Contenido distinto o contención prolongada devuelve 409. Requiere Origin autorizado.`,
        params: {
          type: "object",
          additionalProperties: false,
          required: ["tenantId"],
          properties: { tenantId: uuid },
        },
        headers: {
          type: "object",
          required: ["idempotency-key"],
          properties: {
            "idempotency-key": {
              type: "string",
              pattern: "^[A-Za-z0-9._:-]{1,200}$",
            },
          },
        },
        body: {
          examples: [
            {
              acceptance: {
                usageRulesVersion: 1,
                bookingPolicyVersion: 1,
                nonCancellable: false,
              },
              unitId: "00000000-0000-4000-8000-000000000001",
              startsAt: "2030-01-02T10:00:00Z",
              endsAt: "2030-01-02T11:00:00Z",
            },
          ],
          type: "object",
          additionalProperties: false,
          required: ["unitId", "startsAt", "endsAt"],
          properties: {
            unitId: uuid,
            startsAt: instant,
            endsAt: instant,
            acceptance: {
              ...acceptanceSchema,
              description:
                "Obligatoria para una reserva nueva. Solo puede omitirse al recuperar un comando anterior sin aceptación cuyo resultado siga retenido.",
            },
          },
        },
        response: {
          ...Object.fromEntries(
            [400, 401, 403, 404, 409, 429, 500, 503].map((status) => [
              status,
              { $ref: "ErrorResponse#" },
            ]),
          ),
          201: {
            headers: {
              "idempotency-replayed": {
                type: "string",
                enum: ["true", "false"],
                description: "Indica si se recuperó un resultado anterior.",
              },
              "idempotency-expires-at": {
                type: "string",
                format: "date-time",
                description: "Vencimiento del resultado guardado.",
              },
              "idempotency-retention-seconds": {
                type: "integer",
                description:
                  "Retención configurada para comandos nuevos, en segundos.",
              },
            },
            type: "object",
            additionalProperties: false,
            required: [
              "tenantId",
              "id",
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
              tenantId: uuid,
              id: uuid,
              unitId: uuid,
              startsAt: instant,
              endsAt: instant,
              status: { type: "string", enum: ["CONFIRMADA"] },
              revision: { type: "integer", minimum: 1 },
              calendarVersion: { type: "integer", minimum: 1 },
              cancellationMinutes: { type: "integer", minimum: 0 },
              timeZone: { type: "string" },
              ...acceptanceProperties,
            },
          },
        },
      },
    },
    async (request, reply) => {
      const result = await createReservation(
        pool,
        await actor(request, reply),
        request.params.tenantId,
        request.headers["idempotency-key"],
        request.body,
        request.id,
        retentionSeconds,
      );
      return reply
        .code(201)
        .header("idempotency-replayed", String(result.replayed))
        .header("idempotency-expires-at", result.expiresAt)
        .header("idempotency-retention-seconds", String(retentionSeconds))
        .send(result.result);
    },
  );
}
