import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import {
  type AuthConfiguration,
  type Authentication,
  createRequestActor,
} from "../identity/index.ts";
import { toCsv } from "./csv.ts";
import {
  reservationExportExample,
  reservationExportSchema,
} from "./export-schema.ts";
import { exportReservations } from "./reservation-export.ts";

// Long rule texts stay in the JSON export; the table keeps one scalar per column.
export const reservationCsvColumns = [
  "id",
  "unitId",
  "accountId",
  "startsAt",
  "endsAt",
  "timeZone",
  "status",
  "revision",
  "calendarVersion",
  "cancellationMinutes",
  "usageRulesUnitId",
  "usageRulesVersion",
  "rulesAcceptedAt",
  "pendingUsageRulesVersion",
  "bookingPolicyVersion",
  "conditionsAcceptedAt",
  "nonCancellableAccepted",
] as const;

export async function registerExportRoutes(
  app: FastifyInstance,
  pool: Pool,
  auth: Authentication,
  config: AuthConfiguration,
) {
  const actor = createRequestActor(pool, auth, config);
  const uuid = { type: "string", format: "uuid" };
  const date = { type: "string", format: "date" };
  app.get<{
    Params: { tenantId: string };
    Querystring: {
      from: string;
      to: string;
      unitId?: string;
      format?: "json" | "csv";
    };
  }>(
    "/api/municipalities/:tenantId/exports/reservations",
    {
      schema: {
        operationId: "exportReservations",
        tags: ["Communications"],
        security: [{ quendaSession: [] }],
        description:
          "JSON quenda.reservations v3. DATA_EXPORT y RESERVATION_READ o RESERVATION_MANAGE sobre el mismo ámbito; MFA de los últimos cinco minutos. Sin unitId exige permisos municipales. Fechas locales [from,to), hasta 366 días: incluye reservas que se solapan, conservando intervalos completos. Máximo 10000 reservas; si se supera rechaza sin truncar. usageRulesUnitId y usageRulesVersion identifican las normas aceptadas; pendingUsageRulesVersion corresponde a unitId y no acredita aceptación. Incluye identificadores de titulares, nunca credenciales ni datos de otros municipios.",
        params: {
          type: "object",
          additionalProperties: false,
          required: ["tenantId"],
          properties: { tenantId: uuid },
        },
        querystring: {
          type: "object",
          additionalProperties: false,
          required: ["from", "to"],
          properties: {
            from: date,
            to: date,
            unitId: uuid,
            format: { type: "string", enum: ["json", "csv"] },
          },
        },
        response: {
          ...Object.fromEntries(
            [400, 401, 403, 404, 409, 429, 500, 503].map((status) => [
              status,
              { $ref: "ErrorResponse#" },
            ]),
          ),
          200: {
            description:
              "JSON quenda.reservations v3 (por defecto) o, con format=csv, una fila por reserva con las columnas de reservationCsvColumns.",
            content: {
              "application/json": {
                schema: {
                  ...reservationExportSchema,
                  example: reservationExportExample,
                },
              },
              "text/csv": { schema: { type: "string" } },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const account = await actor(request, reply);
      const document = await exportReservations(
        pool,
        account,
        request.params.tenantId,
        request.query.from,
        request.query.to,
        request.query.unitId ?? null,
      );
      if (request.query.format === "csv")
        return reply
          .header("cache-control", "no-store")
          .header("content-type", "text/csv; charset=utf-8")
          .header(
            "content-disposition",
            'attachment; filename="quenda-reservations-v3.csv"',
          )
          .send(
            toCsv(
              reservationCsvColumns,
              (document as { reservations: Record<string, never>[] })
                .reservations,
            ),
          );
      return reply
        .header("cache-control", "no-store")
        .header(
          "content-disposition",
          'attachment; filename="quenda-reservations-v3.json"',
        )
        .send(document);
    },
  );
}
