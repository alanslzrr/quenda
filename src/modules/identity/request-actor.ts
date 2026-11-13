import { fromNodeHeaders } from "better-auth/node";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { HttpError } from "../../http/errors.ts";
import { rememberAuditActor } from "./access-audit.ts";
import type { AuthConfiguration, Authentication } from "./auth.ts";
import { consumeAdministrativeAttempt } from "./rate-limit.ts";
export function createRequestActor(
  pool: Pool,
  auth: Authentication,
  config: AuthConfiguration,
) {
  const actor = async (request: FastifyRequest, reply: FastifyReply) => {
    // Cookie-based mutation requires the configured Origin, not Host or proxy
    // headers. Missing Origin is rejected too, including requests from scripts.
    if (
      request.method !== "GET" &&
      (request.headers.origin !== config.origin ||
        request.headers["sec-fetch-site"] === "cross-site")
    )
      throw new HttpError("FORBIDDEN");
    const account = await auth.authenticate(fromNodeHeaders(request.headers));
    if (!account) throw new HttpError("UNAUTHENTICATED");
    rememberAuditActor(request, account.accountId);
    const limit = await consumeAdministrativeAttempt(pool, account.accountId);
    if (!limit.allowed) {
      reply.header("retry-after", limit.retryAfter);
      throw new HttpError("RATE_LIMITED");
    }
    return account;
  };
  return actor;
}

/**
 * The signed-in account for a read of its own state that the interface repeats on every page, such as GET /api/me
 * or the unread-notice count. It does not consume the administrative rate limit; anything that changes data or reads
 * municipal records must use the request actor instead.
 */
export function createSessionReader(auth: Authentication) {
  return async (request: FastifyRequest) => {
    const account = await auth.authenticate(fromNodeHeaders(request.headers));
    if (!account) throw new HttpError("UNAUTHENTICATED");
    return account;
  };
}
