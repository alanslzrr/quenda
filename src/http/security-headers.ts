import type { FastifyInstance } from "fastify";

// Public catalog reads may be cached by shared caches; everything else under /api is account data.
function isPrivateApi(url: string) {
  const path = url.split("?", 1)[0] ?? "";
  return path.startsWith("/api/") && !path.startsWith("/api/public/");
}

/**
 * Response headers that never depend on a route: no content sniffing anywhere, and
 * no caching of account responses unless a route chose a policy of its own.
 */
export function registerSecurityHeaders(app: FastifyInstance) {
  app.addHook("onSend", (request, reply, payload, done) => {
    reply.header("x-content-type-options", "nosniff");
    if (isPrivateApi(request.url) && !reply.hasHeader("cache-control"))
      reply.header("cache-control", "no-store");
    done(null, payload);
  });
}
