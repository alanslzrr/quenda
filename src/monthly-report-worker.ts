import { Pool } from "pg";
import {
  assertPrivacyOperational,
  assertRuntimeRole,
} from "./database/pools.ts";
import { HttpError } from "./http/errors.ts";
import { prepareMonthlyAssessment } from "./modules/collaboration/index.ts";

async function run() {
  const [agreementId, month, revision, ...extra] = process.argv.slice(2);
  const connectionString = process.env.WORKER_DATABASE_URL;
  if (
    !connectionString ||
    extra.length ||
    !agreementId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      agreementId,
    ) ||
    !month ||
    !/^\d{4}-\d{2}$/.test(month) ||
    !revision ||
    !/^(0|[1-9]\d*)$/.test(revision) ||
    !Number.isSafeInteger(Number(revision)) ||
    Number(revision) >= 2147483647
  )
    throw new HttpError("INVALID_INPUT");
  const pool = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 3000,
    statement_timeout: 30000,
    application_name: "quenda-monthly-assessment",
  });
  pool.on("error", () =>
    process.stderr.write('{"event":"MONTHLY_DATABASE_UNAVAILABLE"}\n'),
  );
  try {
    await assertRuntimeRole(pool);
    await assertPrivacyOperational(pool);
    if (
      (await pool.query("SELECT current_user AS role")).rows[0]?.role !==
      "quenda_worker"
    )
      throw new HttpError("FORBIDDEN");
    const saved = await prepareMonthlyAssessment(
      pool,
      agreementId.toLowerCase(),
      month,
      Number(revision),
    );
    process.stdout.write(
      `${JSON.stringify({ event: "MONTHLY_ASSESSMENT_PREPARED", agreementId: saved.agreementId, month: saved.month, revision: saved.revision, cutoff: saved.asOf })}\n`,
    );
  } finally {
    await pool.end();
  }
}
run().catch((error) => {
  const code = error instanceof HttpError ? error.code : "INTERNAL_ERROR";
  process.stderr.write(
    `${JSON.stringify({ event: "MONTHLY_ASSESSMENT_FAILED", code })}\n`,
  );
  process.exitCode = 1;
});
