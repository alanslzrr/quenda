import { setTimeout } from "node:timers/promises";
import { DatabaseError, Pool } from "pg";
import {
  assertPrivacyOperational,
  assertRuntimeRole,
} from "./database/pools.ts";
import { readMailConfiguration } from "./mail/config.ts";
import { createMailTransport } from "./mail/transport.ts";
import { processReservationEmail } from "./modules/communications/index.ts";
import { processRetentionBatch } from "./modules/identity/index.ts";

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error("Missing worker configuration");
  return value;
}
function integer(name: string, fallback: number, min: number, max: number) {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error("Invalid worker configuration");
  return value;
}
async function run() {
  if (process.argv.slice(2).some((arg) => arg !== "--once"))
    throw new Error("Invalid worker arguments");
  const locale = required("EMAIL_LOCALE");
  if (locale !== "es" && locale !== "gl")
    throw new Error("Invalid mail locale");
  const origin = new URL(required("AUTH_ORIGIN"));
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    (process.env.NODE_ENV === "production" && origin.protocol !== "https:") ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw new Error("Invalid application origin");
  const options = {
    origin: origin.origin,
    locale,
    leaseSeconds: integer("EMAIL_LEASE_SECONDS", 60, 5, 3600),
    maxAttempts: integer("EMAIL_MAX_ATTEMPTS", 5, 1, 10),
    retrySeconds: integer("EMAIL_RETRY_SECONDS", 60, 1, 86400),
  } as const;
  const idleMs = integer("EMAIL_POLL_MS", 1000, 100, 60000);
  const transport = createMailTransport(readMailConfiguration(process.env));
  const pool = new Pool({
    connectionString: required("WORKER_DATABASE_URL"),
    max: 2,
    connectionTimeoutMillis: 3000,
    statement_timeout: 5000,
    application_name: "quenda-email-worker",
  });
  pool.on("error", () =>
    process.stderr.write('{"event":"EMAIL_DATABASE_UNAVAILABLE"}\n'),
  );
  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await assertRuntimeRole(pool);
    await assertPrivacyOperational(pool);
    if (
      (await pool.query("SELECT current_user AS role")).rows[0]?.role !==
      "quenda_worker"
    )
      throw new Error("Invalid worker role");
    process.stdout.write('{"event":"EMAIL_WORKER_READY"}\n');
    let lastHealthCheck = 0;
    let lastRetentionCheck = 0;
    let lastExhausted: string | null = null;
    do {
      if (Date.now() - lastRetentionCheck >= 60000) {
        try {
          const retention = await processRetentionBatch(pool);
          if (retention.examined || retention.processed)
            process.stdout.write(
              `${JSON.stringify({ event: "RETENTION_BATCH", ...retention })}\n`,
            );
        } catch (error) {
          // Retention is housekeeping: its failure must not stop reservation
          // mail. Only the restore barrier keeps stopping the whole worker.
          if (error instanceof DatabaseError && error.code === "55000")
            throw error;
          process.stderr.write('{"event":"RETENTION_BATCH_FAILED"}\n');
        }
        lastRetentionCheck = Date.now();
      }
      const outcome = await processReservationEmail(pool, transport, options);
      if (outcome !== "IDLE")
        process.stdout.write(
          `${JSON.stringify({ event: "EMAIL_ATTEMPT", outcome })}\n`,
        );
      if (Date.now() - lastHealthCheck >= 60000 || outcome === "EXHAUSTED") {
        const health = (
          await pool.query<{
            pending: string;
            leased: string;
            exhausted: string;
          }>("SELECT * FROM domain.reservation_email_health()")
        ).rows[0];
        if (!health) throw new Error("Missing queue health");
        process.stdout.write(
          `${JSON.stringify({ event: "EMAIL_QUEUE_HEALTH", ...health })}\n`,
        );
        if (health.exhausted !== "0" && health.exhausted !== lastExhausted)
          process.stderr.write(
            `${JSON.stringify({ event: "EMAIL_QUEUE_ATTENTION", exhausted: health.exhausted })}\n`,
          );
        lastExhausted = health.exhausted;
        lastHealthCheck = Date.now();
      }
      if (process.argv.includes("--once") || shutdown.signal.aborted) break;
      if (outcome === "IDLE") {
        try {
          await setTimeout(idleMs, undefined, { signal: shutdown.signal });
        } catch (error) {
          if (!shutdown.signal.aborted) throw error;
        }
      }
    } while (!shutdown.signal.aborted);
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await pool.end();
  }
}
run().catch(() => {
  process.stderr.write('{"event":"EMAIL_WORKER_FAILED"}\n');
  process.exitCode = 1;
});
