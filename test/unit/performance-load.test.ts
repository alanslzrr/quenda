import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  acceptanceLoad,
  assessAcceptance,
  type LoadSample,
  loadPlan,
  runLoad,
  summarizeLoad,
} from "../performance/load.ts";

test("acceptance load schedules all ten minutes with exact 80/20 mix across ten sessions", () => {
  const plan = loadPlan(
    acceptanceLoad.requests,
    acceptanceLoad.intervalMs,
    acceptanceLoad.sessions,
  );
  assert.equal(plan.length, 3000);
  assert.equal(plan.filter((slot) => slot.kind === "read").length, 2400);
  assert.equal(plan.filter((slot) => slot.kind === "write").length, 600);
  assert.equal(plan.at(-1)?.scheduledMs, 599800);
  for (let session = 0; session < 10; session++) {
    assert.equal(plan.filter((slot) => slot.session === session).length, 300);
    assert.equal(
      plan.filter((slot) => slot.session === session && slot.kind === "write")
        .length,
      60,
    );
  }
  for (const args of [
    [0, 200, 10],
    [1, 0, 10],
    [1, 200, 0],
    [1.5, 200, 10],
  ] as const)
    assert.throws(() => loadPlan(args[0], args[1], args[2]));
});
test("percentiles use nearest ranks of valid results and retain error counts separately", () => {
  const samples: LoadSample[] = Array.from({ length: 100 }, (_, i) => ({
    index: i,
    session: 0,
    kind: "read",
    scheduledMs: i,
    latencyMs: i + 1,
    scheduledLatencyMs: i + 3,
    dispatchDelayMs: 2,
    outcome: "valid",
    status: 200,
  }));
  samples.push({
    index: 100,
    session: 0,
    kind: "write",
    scheduledMs: 100,
    latencyMs: 1000,
    scheduledLatencyMs: 1000,
    dispatchDelayMs: 0,
    outcome: "invalid",
    status: 409,
  });
  const report = summarizeLoad(samples);
  assert.equal(report.read?.latencyMs.p50, 50);
  assert.equal(report.read?.latencyMs.p95, 95);
  assert.equal(report.read?.latencyMs.p99, 99);
  assert.equal(report.read?.scheduledLatencyMs.p95, 97);
  assert.equal(report.write?.latencyMs.count, 0);
  assert.equal(report.write?.latencyMs.p95, null);
  assert.equal(report.write?.outcomes.invalid, 1);
});
test("open-loop scheduling accounts for busy sessions instead of hiding overload", async () => {
  const result = await runLoad(
    { requests: 10, intervalMs: 5, sessions: 1, timeoutMs: 500 },
    async () => {
      await delay(40);
      return { status: 200, valid: true };
    },
  );
  assert.equal(result.samples.length, 10);
  assert.equal(result.maximumActive, 1);
  assert.ok(result.samples.some((sample) => sample.outcome === "sessionBusy"));
  assert.ok(result.samples.some((sample) => sample.outcome === "valid"));
  assert.ok(result.elapsedMs >= result.plannedWindowMs);
  assert.deepEqual(
    result.samples.map((sample) => sample.index),
    Array.from({ length: 10 }, (_, i) => i),
  );
});
test("timeouts abort transport, while transport failures and invalid responses remain distinct", async () => {
  let aborted = false;
  const timed = await runLoad(
    { requests: 1, intervalMs: 1, sessions: 1, timeoutMs: 10 },
    async (_slot, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("secret transport details"));
        });
      }),
  );
  assert.equal(aborted, true);
  assert.equal(timed.samples[0]?.outcome, "timeout");
  const broken = await runLoad(
    { requests: 1, intervalMs: 1, sessions: 1, timeoutMs: 100 },
    async () => {
      throw new Error("secret transport details");
    },
  );
  assert.equal(broken.samples[0]?.outcome, "transportError");
  assert.ok(!JSON.stringify(broken).includes("secret"));
});

test("acceptance gate rejects shortened runs, missing requests, failed operations and scheduler delay", () => {
  const samples: LoadSample[] = loadPlan(3000, 200, 10).map((slot) => ({
    ...slot,
    outcome: "valid",
    status: 200,
    latencyMs: 10,
    dispatchDelayMs: 0,
    scheduledLatencyMs: 10,
  }));
  const full = {
    plannedWindowMs: 600000,
    elapsedMs: 600000,
    maximumActive: 10,
    samples,
    summary: summarizeLoad(samples),
  };
  assert.equal(assessAcceptance(full).passed, true);
  assert.equal(
    assessAcceptance({ ...full, plannedWindowMs: 1000 }).passed,
    false,
  );
  assert.equal(
    assessAcceptance({ ...full, samples: samples.slice(1) }).passed,
    false,
  );
  assert.equal(
    assessAcceptance({
      ...full,
      samples: samples.map((sample, i) =>
        i === 0 ? { ...sample, outcome: "timeout" } : sample,
      ),
    }).passed,
    false,
  );
  assert.equal(
    assessAcceptance({
      ...full,
      samples: samples.map((sample) => ({
        ...sample,
        dispatchDelayMs: 2000,
        scheduledLatencyMs: 2010,
      })),
    }).passed,
    false,
  );
});
