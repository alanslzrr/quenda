import type { FastifyBaseLogger, FastifyInstance } from "fastify";

const boundsMs = [
  5, 10, 25, 50, 100, 250, 500, 1000, 1500, 2500, 5000, 10000,
] as const;
function counters() {
  return {
    requests: 0,
    durationMs: 0,
    maximumMs: 0,
    statuses: {
      success: 0,
      redirect: 0,
      clientError: 0,
      serverError: 0,
      other: 0,
    },
    latencyBuckets: Array<number>(boundsMs.length + 1).fill(0),
  };
}
export function createHttpMetrics() {
  const values = { read: counters(), write: counters() };
  return {
    record(method: string, status: number, elapsedMs: number) {
      if (
        !Number.isFinite(elapsedMs) ||
        elapsedMs < 0 ||
        !Number.isInteger(status)
      )
        return;
      const value =
        values[method === "GET" || method === "HEAD" ? "read" : "write"];
      value.requests++;
      value.durationMs += elapsedMs;
      value.maximumMs = Math.max(value.maximumMs, elapsedMs);
      const category =
        status >= 200 && status < 300
          ? "success"
          : status >= 300 && status < 400
            ? "redirect"
            : status >= 400 && status < 500
              ? "clientError"
              : status >= 500 && status < 600
                ? "serverError"
                : "other";
      value.statuses[category]++;
      const index = boundsMs.findIndex((bound) => elapsedMs <= bound);
      const bucket = index < 0 ? boundsMs.length : index;
      value.latencyBuckets[bucket] = (value.latencyBuckets[bucket] ?? 0) + 1;
    },
    snapshot() {
      return {
        bucketUpperBoundsMs: [...boundsMs, "+Inf"],
        ...structuredClone(values),
      };
    },
  };
}
export function registerHttpMetrics(
  app: FastifyInstance,
  logger: Pick<FastifyBaseLogger, "info" | "warn"> = app.log,
) {
  const metrics = createHttpMetrics();
  app.addHook("onResponse", async (request, reply) =>
    metrics.record(request.method, reply.statusCode, reply.elapsedTime),
  );
  let reportedErrors = 0;
  const timer = setInterval(() => {
    const snapshot = metrics.snapshot();
    logger.info({ event: "HTTP_METRICS", ...snapshot }, "HTTP metrics");
    const errors =
      snapshot.read.statuses.serverError + snapshot.write.statuses.serverError;
    if (errors > reportedErrors)
      logger.warn(
        {
          event: "HTTP_SERVER_ERRORS",
          count: errors - reportedErrors,
          total: errors,
        },
        "HTTP server errors observed",
      );
    reportedErrors = errors;
  }, 30000).unref();
  app.addHook("onClose", async () => clearInterval(timer));
}
