import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { command } from "../../database/command.ts";
import {
  type AuthConfiguration,
  type Authentication,
  createRequestActor,
  requireMfaSession,
  requireRecentMfa,
} from "../identity/index.ts";

export async function registerAgendaRoutes(
  app: FastifyInstance,
  pool: Pool,
  auth: Authentication,
  config: AuthConfiguration,
) {
  const actor = createRequestActor(pool, auth, config);
  const uuid = { type: "string", format: "uuid" };
  for (const units of [true, false]) {
    const properties = units
      ? { id: uuid, name: { type: "string" } }
      : {
          id: uuid,
          unitId: uuid,
          startsAt: { type: "string", format: "date-time" },
          endsAt: { type: "string", format: "date-time" },
          reason: { type: "string" },
          releasedAt: { type: "string", format: "date-time", nullable: true },
        };
    app.get<{
      Params: { tenantId: string };
      Querystring: { after?: string; unitId?: string; date?: string };
    }>(
      units
        ? "/api/municipalities/:tenantId/agenda/units"
        : "/api/municipalities/:tenantId/blocks",
      {
        schema: {
          operationId: units ? "municipalAgendaUnits" : "municipalBlocks",
          tags: ["Reservations"],
          security: [{ quendaSession: [] }],
          description: units
            ? "Unidades autorizadas para RESERVATION_READ, RESERVATION_MANAGE o UNIT_BLOCK, incluidas retiradas. Solo identifica unidades; no concede acceso al catálogo."
            : "Bloqueos visibles con UNIT_BLOCK y MFA reciente, incluidos liberados. date filtra solapes con el día municipal antes de paginar. No expone bloqueos de otras unidades.",
          params: {
            type: "object",
            additionalProperties: false,
            required: ["tenantId"],
            properties: { tenantId: uuid },
          },
          querystring: {
            type: "object",
            additionalProperties: false,
            properties: units
              ? { after: uuid }
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
                nextCursor: { ...uuid, nullable: true },
                items: {
                  type: "array",
                  maxItems: 20,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: Object.keys(properties),
                    properties,
                  },
                },
              },
            },
          },
        },
      },
      async (request, reply) => {
        const account = await actor(request, reply);
        requireMfaSession(account);
        if (!units) requireRecentMfa(account);
        reply.header("cache-control", "no-store");
        return command(
          pool,
          { tenantId: request.params.tenantId, accountId: account.accountId },
          async (client) => {
            const { tenantId } = request.params;
            const { after, unitId, date } = request.query;
            const result = await client.query(
              units
                ? "SELECT * FROM domain.agenda_units($1)"
                : `SELECT id,unit_id AS "unitId",starts_at AS "startsAt",ends_at AS "endsAt",reason,released_at AS "releasedAt" FROM domain.schedule_block
          WHERE tenant_id=$1 AND ($2::uuid IS NULL OR id>$2) AND ($3::uuid IS NULL OR unit_id=$3)
          AND ($4::date IS NULL OR (starts_at < (($4::date+1)::timestamp AT TIME ZONE (SELECT timezone FROM domain.municipality WHERE id=$1)) AND ends_at > ($4::date::timestamp AT TIME ZONE (SELECT timezone FROM domain.municipality WHERE id=$1))))
          ORDER BY id LIMIT 21`,
              units
                ? [after ?? null]
                : [tenantId, after ?? null, unitId ?? null, date ?? null],
            );
            const items = result.rows.slice(0, 20);
            return {
              items,
              nextCursor: result.rows.length > 20 ? items.at(-1)?.id : null,
            };
          },
        );
      },
    );
  }
}
