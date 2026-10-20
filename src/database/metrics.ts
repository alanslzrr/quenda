import type { Pool } from "pg";

interface CommandMetrics {
  started: number;
  active: number;
  committed: number;
  failed: number;
  retries: number;
  serializationFailures: number;
  deadlocks: number;
  retryExhaustions: number;
  totalDurationMs: number;
  maximumDurationMs: number;
}
const metrics = new WeakMap<Pool, CommandMetrics>();
function counters(pool: Pool): CommandMetrics {
  let value = metrics.get(pool);
  if (!value) {
    value = {
      started: 0,
      active: 0,
      committed: 0,
      failed: 0,
      retries: 0,
      serializationFailures: 0,
      deadlocks: 0,
      retryExhaustions: 0,
      totalDurationMs: 0,
      maximumDurationMs: 0,
    };
    metrics.set(pool, value);
  }
  return value;
}
export function beginCommandMeasurement(pool: Pool) {
  const value = counters(pool),
    start = performance.now();
  value.started++;
  value.active++;
  return {
    conflict(code: string | undefined, retry: boolean) {
      if (code === "40001") value.serializationFailures++;
      if (code === "40P01") value.deadlocks++;
      if (retry) value.retries++;
      else if (code === "40001" || code === "40P01") value.retryExhaustions++;
    },
    finish(committed: boolean) {
      value.active--;
      if (committed) value.committed++;
      else value.failed++;
      const elapsed = performance.now() - start;
      value.totalDurationMs += elapsed;
      value.maximumDurationMs = Math.max(value.maximumDurationMs, elapsed);
    },
  };
}
export function databaseMetrics(pool: Pool) {
  return {
    commands: { ...counters(pool) },
    connections: {
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
    },
  };
}
