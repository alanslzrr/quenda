import { createHmac } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { HttpError } from "./errors.ts";

export function publicSubjectHash(secret: string, ip: string): string {
  return createHmac("sha256", secret)
    .update("quenda:public-catalog\0")
    .update(ip)
    .digest("hex");
}
export async function consumePublicAttempt(pool: Pool, subject: string) {
  const result = await pool.query<{ allowed: boolean; retry_after: number }>(
    "SELECT * FROM domain.consume_public_attempt($1)",
    [subject],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Missing public rate-limit decision");
  return { allowed: row.allowed, retryAfter: row.retry_after };
}
/** One public allowance per address; a bucket gives a route an allowance of its own. */
export function publicRateLimit(pool: Pool, secret: string, bucket?: string) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const decision = await consumePublicAttempt(
      pool,
      publicSubjectHash(
        secret,
        bucket ? `${bucket}\0${request.ip}` : request.ip,
      ),
    );
    if (!decision.allowed) {
      reply.header("retry-after", decision.retryAfter);
      throw new HttpError("RATE_LIMITED");
    }
  };
}
