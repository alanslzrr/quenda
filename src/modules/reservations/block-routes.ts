import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import {
  type AuthConfiguration,
  type Authentication,
  createRequestActor,
} from "../identity/index.ts";
import { createBlock, releaseBlock } from "./blocks.ts";

export async function registerBlockRoutes(
  app: FastifyInstance,
  pool: Pool,
  auth: Authentication,
  config: AuthConfiguration,
  retentionSeconds: number,
) {
  const actor = createRequestActor(pool, auth, config);
  const uuid = { type: "string", format: "uuid" },
    instant = { type: "string", format: "date-time" },
    reason = { type: "string", minLength: 1, maxLength: 500 };
  const result = {
    type: "object",
    additionalProperties: false,
    required: [
      "id",
      "tenantId",
      "unitId",
      "startsAt",
      "endsAt",
      "reason",
      "releasedAt",
    ],
    properties: {
      id: uuid,
      tenantId: uuid,
      unitId: uuid,
      startsAt: instant,
      endsAt: instant,
      reason,
      releasedAt: { ...instant, nullable: true },
    },
    headers: {
      "idempotency-replayed": { type: "string", enum: ["true", "false"] },
      "idempotency-expires-at": instant,
      "idempotency-retention-seconds": { type: "integer" },
    },
  };
  for (const action of ["create", "release"] as const) {
    const creating = action === "create";
    app.post<{
      Params: { tenantId: string; blockId?: string };
      Headers: { "idempotency-key": string };
      Body: {
        reason: string;
        unitId: string;
        startsAt: string;
        endsAt: string;
      };
    }>(
      creating
        ? "/api/municipalities/:tenantId/blocks"
        : "/api/municipalities/:tenantId/blocks/:blockId/release",
      {
        schema: {
          operationId: creating ? "createBlock" : "releaseBlock",
          tags: ["Reservations"],
          security: [{ quendaSession: [] }],
          description: `${creating ? "Crea un bloqueo; rechaza solapes con reservas o bloqueos no liberados. No cancela reservas." : "Libera el bloqueo y su ocupación sin borrar el historial; repetir la retirada no genera otro evento."} Exige UNIT_BLOCK, MFA reciente y motivo. Retención idempotente: ${retentionSeconds} segundos.`,
          params: {
            type: "object",
            additionalProperties: false,
            required: creating ? ["tenantId"] : ["tenantId", "blockId"],
            properties: creating
              ? { tenantId: uuid }
              : { tenantId: uuid, blockId: uuid },
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
            type: "object",
            additionalProperties: false,
            required: creating
              ? ["unitId", "startsAt", "endsAt", "reason"]
              : ["reason"],
            properties: creating
              ? { unitId: uuid, startsAt: instant, endsAt: instant, reason }
              : { reason },
          },
          response: {
            ...Object.fromEntries(
              [400, 401, 403, 404, 409, 429, 500, 503].map((s) => [
                s,
                { $ref: "ErrorResponse#" },
              ]),
            ),
            [creating ? 201 : 200]: result,
          },
        },
      },
      async (request, reply) => {
        const account = await actor(request, reply);
        const saved = creating
          ? await createBlock(
              pool,
              account,
              request.params.tenantId,
              request.headers["idempotency-key"],
              request.body,
              request.id,
              retentionSeconds,
            )
          : await releaseBlock(
              pool,
              account,
              request.params.tenantId,
              request.params.blockId as string,
              request.headers["idempotency-key"],
              request.body,
              request.id,
              retentionSeconds,
            );
        return reply
          .code(creating ? 201 : 200)
          .header("idempotency-replayed", String(saved.replayed))
          .header("idempotency-expires-at", saved.expiresAt)
          .header("idempotency-retention-seconds", String(retentionSeconds))
          .send(saved.result);
      },
    );
  }
}
