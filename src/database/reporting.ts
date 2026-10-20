import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";
import { databaseMetrics } from "./metrics.ts";

export function startDatabaseReporting(
  pools: { domain: Pool; auth: Pool },
  logger: Pick<FastifyBaseLogger, "info" | "warn">,
) {
  const seen = { domain: 0, auth: 0 };
  const timer = setInterval(() => {
    const snapshot = {
      domain: databaseMetrics(pools.domain),
      auth: databaseMetrics(pools.auth),
    };
    logger.info({ event: "DATABASE_METRICS", ...snapshot }, "Database metrics");
    for (const pool of ["domain", "auth"] as const) {
      const exhausted = snapshot[pool].commands.retryExhaustions;
      if (exhausted > seen[pool]) {
        logger.warn(
          {
            event: "DATABASE_RETRY_EXHAUSTED",
            pool,
            count: exhausted - seen[pool],
            total: exhausted,
          },
          "Transaction retries exhausted",
        );
      }
      seen[pool] = exhausted;
    }
  }, 30000).unref();
  return () => clearInterval(timer);
}
