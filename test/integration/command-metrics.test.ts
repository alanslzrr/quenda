import assert from "node:assert/strict";
import test from "node:test";
import { command } from "../../src/database/command.ts";
import { databaseMetrics } from "../../src/database/metrics.ts";
import { withDatabase } from "../helpers/postgres.ts";

test("command metrics count retries, terminal failures and concurrent activity without labels", {
  timeout: 60000,
}, async () => {
  await withDatabase(async ({ domain, auth }) => {
    assert.equal(databaseMetrics(domain).commands.started, 0);
    let attempts = 0;
    await command(domain, undefined, async (client) => {
      attempts++;
      if (attempts < 3)
        await client.query(
          "DO $$ BEGIN RAISE EXCEPTION 'secret-context' USING ERRCODE='40001'; END $$",
        );
    });
    await assert.rejects(
      command(domain, undefined, async (client) => {
        await client.query(
          "DO $$ BEGIN RAISE EXCEPTION 'secret-context' USING ERRCODE='40P01'; END $$",
        );
      }),
      { code: "40P01" },
    );
    await assert.rejects(
      command(domain, undefined, async () => {
        throw new Error("secret-context");
      }),
      /secret-context/,
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const active = command(domain, undefined, async () => {
      entered();
      await gate;
    });
    await ready;
    const during = databaseMetrics(domain);
    assert.equal(during.commands.active, 1);
    release();
    await active;
    const snapshot = databaseMetrics(domain);
    assert.deepEqual(
      { ...snapshot.commands, totalDurationMs: 0, maximumDurationMs: 0 },
      {
        started: 4,
        active: 0,
        committed: 2,
        failed: 2,
        retries: 4,
        serializationFailures: 2,
        deadlocks: 3,
        retryExhaustions: 1,
        totalDurationMs: 0,
        maximumDurationMs: 0,
      },
    );
    assert.ok(
      snapshot.commands.totalDurationMs >= snapshot.commands.maximumDurationMs,
    );
    assert.ok(snapshot.commands.maximumDurationMs > 0);
    assert.equal(snapshot.connections.waiting, 0);
    assert.equal(databaseMetrics(auth).commands.started, 0);
    snapshot.commands.started = 999;
    assert.equal(databaseMetrics(domain).commands.started, 4);
    assert.ok(!JSON.stringify(snapshot).includes("secret-context"));
  });
});
