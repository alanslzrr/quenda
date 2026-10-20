import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import {
  createHttpMetrics,
  registerHttpMetrics,
} from "../../src/http/metrics.ts";

test("HTTP metrics use bounded exclusive buckets and snapshots cannot mutate counters", () => {
  const metrics = createHttpMetrics();
  for (const [method, status, time] of [
    ["GET", 200, 5],
    ["HEAD", 304, 10],
    ["POST", 400, 1500],
    ["PATCH", 503, 10001],
    ["GET", 200, 6],
    ["OPTIONS", 204, 0],
  ] as const)
    metrics.record(method, status, time);
  for (const time of [NaN, Infinity, -1]) metrics.record("GET", 200, time);
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.read.requests, 3);
  assert.equal(snapshot.write.requests, 3);
  assert.equal(snapshot.read.durationMs, 21);
  assert.equal(snapshot.write.maximumMs, 10001);
  assert.equal(snapshot.read.latencyBuckets[0], 1);
  assert.equal(snapshot.read.latencyBuckets[1], 2);
  assert.equal(snapshot.write.latencyBuckets[8], 1);
  assert.equal(snapshot.write.latencyBuckets.at(-1), 1);
  assert.equal(snapshot.write.statuses.clientError, 1);
  assert.equal(snapshot.write.statuses.serverError, 1);
  assert.equal(snapshot.read.statuses.redirect, 1);
  assert.equal(
    snapshot.write.latencyBuckets.reduce((a, b) => a + b, 0),
    3,
  );
  snapshot.read.requests = 99;
  snapshot.read.latencyBuckets.fill(99);
  assert.equal(metrics.snapshot().read.requests, 3);
  assert.equal(metrics.snapshot().read.latencyBuckets[0], 1);
});

test("HTTP hooks report completed requests, alert new server errors and stop on close without sensitive dimensions", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const reports: unknown[] = [],
    alerts: unknown[] = [];
  const app = Fastify({ logger: false });
  registerHttpMetrics(app, {
    info: (data: unknown) => {
      reports.push(data);
    },
    warn: (data: unknown) => {
      alerts.push(data);
    },
  });
  app.get("/item/:privateId", async () => ({ ok: true }));
  app.post("/item", async (_request, reply) =>
    reply.code(503).send({ error: true }),
  );
  app.get("/bad", async (_request, reply) =>
    reply.code(400).send({ error: true }),
  );
  try {
    await app.inject({
      url: "/item/secret-subject?email=private@example.test",
    });
    await app.inject({ url: "/bad" });
    t.mock.timers.tick(30000);
    assert.equal(reports.length, 1);
    assert.equal(alerts.length, 0);
    await app.inject({
      url: "/item",
      method: "POST",
      payload: { secret: "password" },
    });
    t.mock.timers.tick(30000);
    assert.deepEqual(alerts, [
      { event: "HTTP_SERVER_ERRORS", count: 1, total: 1 },
    ]);
    t.mock.timers.tick(30000);
    assert.equal(alerts.length, 1);
    const snapshot = reports[2] as {
      read: { requests: number };
      write: { requests: number };
    };
    assert.equal(snapshot.read.requests, 2);
    assert.equal(snapshot.write.requests, 1);
    assert.ok(!/secret|private|password|item/.test(JSON.stringify(reports)));
    await app.close();
    t.mock.timers.tick(90000);
    assert.equal(reports.length, 3);
  } finally {
    await app.close();
    t.mock.timers.reset();
  }
});
