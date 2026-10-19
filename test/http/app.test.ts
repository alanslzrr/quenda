import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../../src/app.ts";
import { HttpError } from "../../src/http/errors.ts";

const database = { check: async () => {}, close: async () => {} };

test("malformed, oversized and unsupported bodies retain their client-error status", async () => {
  const app = await buildApp({ database, logLevel: "silent" });
  app.post("/body", async () => ({ ok: true }));
  try {
    for (const [contentType, payload, expected] of [
      ["application/json", "{", 400],
      ["application/json", JSON.stringify({ value: "x".repeat(1048576) }), 413],
      ["application/xml", "<x />", 415],
    ] as const) {
      const reply = await app.inject({
        method: "POST",
        url: "/body",
        headers: { "content-type": contentType },
        payload,
      });
      assert.equal(reply.statusCode, expected);
      assert.ok(reply.json().error.code);
    }
  } finally {
    await app.close();
  }
});

test("health and request correlation work without a listening port; close releases database", async () => {
  let closed = 0;
  const app = await buildApp({
    logLevel: "silent",
    database: {
      ...database,
      close: async () => {
        closed++;
      },
    },
  });
  try {
    for (const url of ["/health/live", "/health/ready"]) {
      const reply = await app.inject({
        url,
        headers: { "x-request-id": "untrusted-client-value" },
      });
      assert.equal(reply.statusCode, 200);
      assert.deepEqual(reply.json(), { status: "ok" });
      assert.match(String(reply.headers["x-request-id"]), /^[0-9a-f-]{36}$/);
    }
  } finally {
    await app.close();
  }
  assert.equal(closed, 1);
});

test("database failure is readiness 503, not liveness failure or credential disclosure", async () => {
  const app = await buildApp({
    logLevel: "silent",
    database: {
      ...database,
      check: async () => {
        throw new Error("postgres://TOPSECRET");
      },
    },
  });
  try {
    const reply = await app.inject({
      url: "/health/ready",
      headers: { "accept-language": "gl" },
    });
    assert.equal(reply.statusCode, 503);
    assert.equal(reply.json().error.code, "UNAVAILABLE");
    assert.equal(reply.headers["content-language"], "gl");
    assert.ok(!reply.body.includes("TOPSECRET"));
    assert.equal((await app.inject("/health/live")).statusCode, 200);
  } finally {
    await app.close();
  }
});

test("validation reports fields without reflecting input and preserves strict schema", async () => {
  const app = await buildApp({ database, logLevel: "silent" });
  app.post(
    "/test-input",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["name"],
          properties: { name: { type: "string" } },
        },
      },
    },
    async () => ({ ok: true }),
  );
  try {
    const reply = await app.inject({
      method: "POST",
      url: "/test-input",
      payload: { password: "TOPSECRET" },
    });
    assert.equal(reply.statusCode, 400);
    assert.equal(reply.json().error.code, "INVALID_INPUT");
    assert.ok(reply.json().error.fields.length > 0);
    assert.ok(!reply.body.includes("TOPSECRET"));
    assert.equal(reply.json().requestId, reply.headers["x-request-id"]);
    const numeric = await app.inject({
      method: "POST",
      url: "/test-input",
      payload: { name: 123 },
    });
    assert.equal(numeric.statusCode, 400);
  } finally {
    await app.close();
  }
});

test("errors use stable codes; unknown routes and internal failures disclose no details", async () => {
  const app = await buildApp({ database, logLevel: "silent" });
  app.get("/forbidden", async () => {
    throw new HttpError("FORBIDDEN");
  });
  app.get("/broken", async () => {
    throw new Error("TOPSECRET");
  });
  try {
    assert.equal((await app.inject("/missing")).json().error.code, "NOT_FOUND");
    assert.equal((await app.inject("/forbidden")).statusCode, 403);
    const broken = await app.inject("/broken");
    assert.equal(broken.statusCode, 500);
    assert.ok(!broken.body.includes("TOPSECRET"));
  } finally {
    await app.close();
  }
});

test("OpenAPI is generated from implemented health routes, including response schemas", async () => {
  const app = await buildApp({ database, logLevel: "silent" });
  try {
    await app.ready();
    const spec = app.swagger();
    assert.equal(spec.info.license?.name, "AGPL-3.0-only");
    assert.ok(spec.paths?.["/health/ready"]?.get?.responses?.["503"]);
    assert.ok(spec.paths?.["/health/live"]?.get?.responses?.["200"]);
    assert.deepEqual(Object.keys(spec.paths ?? {}).sort(), [
      "/health/live",
      "/health/ready",
    ]);
  } finally {
    await app.close();
  }
});
