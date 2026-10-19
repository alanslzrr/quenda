import type { FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { command } from "../../database/command.ts";
import type { ErrorCode } from "../../http/errors.ts";

const actors = new WeakMap<FastifyRequest, string>();
export function rememberAuditActor(request: FastifyRequest, accountId: string) {
  actors.set(request, accountId);
}

export function accessFailureAudit(pool: Pool) {
  return async (request: FastifyRequest, code: ErrorCode) => {
    const accountId = actors.get(request);
    const operation = request.routeOptions.schema?.operationId;
    if (
      !operation ||
      ![
        "FORBIDDEN",
        "UNAUTHENTICATED",
        "REAUTHENTICATION_REQUIRED",
        "NOT_FOUND",
        "RATE_LIMITED",
        "INVALID_INPUT",
        "CONFLICT",
      ].includes(code)
    )
      return;
    if (!accountId) {
      // No session was established (including CSRF rejection before auth).
      // Never infer an actor from a cookie, request body or client header.
      request.log.warn(
        { operation, outcome: code },
        "Unattributed access rejection",
      );
      return;
    }
    const params = request.params as { tenantId?: unknown } | undefined;
    const tenant = params?.tenantId;
    const requestedTenant =
      typeof tenant === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        tenant,
      )
        ? tenant
        : null;
    // Runs after the rejected command has released/rolled back its connection.
    // No payload, free-text reason, token, session identifier or URL is copied.
    await command(pool, { accountId, tenantId: null }, async (client) => {
      await client.query(
        "INSERT INTO domain.access_denial(request_id,actor_id,requested_tenant_id,operation,outcome) VALUES ($1,$2,$3,$4,$5)",
        [request.id, accountId, requestedTenant, operation, code],
      );
    });
  };
}
