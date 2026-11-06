import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../../src/app.ts";

const database = { check: async () => {}, close: async () => {} };

async function app() {
  const instance = await buildApp({ database, logLevel: "silent" });
  instance.get("/api/me/private", async () => ({ ok: true }));
  instance.get("/api/public/catalog", async () => ({ ok: true }));
  instance.get("/api/me/chosen", async (_request, reply) => {
    reply.header("cache-control", "private, max-age=5");
    return { ok: true };
  });
  instance.get("/api/me/failing", async () => {
    throw new Error("boom");
  });
  return instance;
}

test("account responses are never cacheable unless a route chose its own policy", async () => {
  const server = await app();
  try {
    const privateReply = await server.inject({ url: "/api/me/private" });
    assert.equal(privateReply.headers["cache-control"], "no-store");
    assert.equal(privateReply.headers["x-content-type-options"], "nosniff");
    const chosen = await server.inject({ url: "/api/me/chosen" });
    assert.equal(chosen.headers["cache-control"], "private, max-age=5");
    // Failures and unknown API paths carry the same protection.
    for (const url of ["/api/me/failing", "/api/me/missing?x=1"]) {
      const failure = await server.inject({ url });
      assert.equal(failure.headers["cache-control"], "no-store", url);
      assert.equal(failure.headers["x-content-type-options"], "nosniff", url);
    }
  } finally {
    await server.close();
  }
});

test("public catalog responses stay cacheable but are never sniffed", async () => {
  const server = await app();
  try {
    const reply = await server.inject({ url: "/api/public/catalog" });
    assert.equal(reply.headers["cache-control"], undefined);
    assert.equal(reply.headers["x-content-type-options"], "nosniff");
  } finally {
    await server.close();
  }
});

test("health probes are not given account-data cache rules", async () => {
  const server = await app();
  try {
    const reply = await server.inject({ url: "/health/ready" });
    assert.equal(reply.headers["cache-control"], undefined);
    assert.equal(reply.headers["x-content-type-options"], "nosniff");
  } finally {
    await server.close();
  }
});
