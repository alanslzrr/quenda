import assert from "node:assert/strict";
import test from "node:test";
import { Pool } from "pg";
import { beginCommandMeasurement } from "../../src/database/metrics.ts";
import { startDatabaseReporting } from "../../src/database/reporting.ts";

test("database reporting publishes bounded snapshots, alerts only new exhausted retries and stops", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const domain = new Pool({
    connectionString:
      "postgresql://secret-user:secret-password@invalid/database",
  });
  const auth = new Pool();
  const reports: Record<string, unknown>[] = [],
    alerts: Record<string, unknown>[] = [];
  const stop = startDatabaseReporting(
    { domain, auth },
    {
      info: (data: unknown) => {
        reports.push(data as Record<string, unknown>);
      },
      warn: (data: unknown) => {
        alerts.push(data as Record<string, unknown>);
      },
    },
  );
  try {
    t.mock.timers.tick(29999);
    assert.equal(reports.length, 0);
    const businessFailure = beginCommandMeasurement(domain);
    businessFailure.conflict(undefined, false);
    businessFailure.finish(false);
    t.mock.timers.tick(1);
    assert.equal(reports.length, 1);
    assert.equal(alerts.length, 0);
    const command = beginCommandMeasurement(domain);
    command.conflict("40001", true);
    command.conflict("40P01", true);
    command.conflict("40001", false);
    command.finish(false);
    t.mock.timers.tick(30000);
    assert.deepEqual(alerts, [
      { event: "DATABASE_RETRY_EXHAUSTED", pool: "domain", count: 1, total: 1 },
    ]);
    t.mock.timers.tick(30000);
    assert.equal(alerts.length, 1);
    const next = beginCommandMeasurement(auth);
    next.conflict("40P01", false);
    next.finish(false);
    t.mock.timers.tick(30000);
    assert.deepEqual(alerts[1], {
      event: "DATABASE_RETRY_EXHAUSTED",
      pool: "auth",
      count: 1,
      total: 1,
    });
    assert.ok(!JSON.stringify({ reports, alerts }).includes("secret"));
    const before = reports.length;
    stop();
    stop();
    t.mock.timers.tick(90000);
    assert.equal(reports.length, before);
  } finally {
    stop();
    t.mock.timers.reset();
    await Promise.all([domain.end(), auth.end()]);
  }
});
