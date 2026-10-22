import assert from "node:assert/strict";
import test from "node:test";
import { ApiError, api } from "../src/app/api.ts";

test("API client rejects external URLs before sending credentials", async (context) => {
  const fetch = context.mock.method(globalThis, "fetch", async () =>
    Response.json({}),
  );
  for (const path of [
    "https://example.test/api/me",
    "//example.test/api/me",
    "/api/\\example.test",
  ])
    await assert.rejects(api(path), /Invalid API path/);
  assert.equal(fetch.mock.callCount(), 0);
});
test("API client keeps cookies, locale and mutation headers on the same origin", async (context) => {
  const fetch = context.mock.method(globalThis, "fetch", async () =>
    Response.json({ theme: "dark" }),
  );
  const result = await api(
    "/api/me/theme",
    { method: "PUT", body: '{"theme":"dark"}' },
    "es",
  );
  assert.deepEqual(result, { theme: "dark" });
  const [url, options] = fetch.mock.calls[0].arguments;
  assert.equal(url, "/api/me/theme");
  assert.equal(options?.credentials, "same-origin");
  assert.equal(options?.redirect, "error");
  assert.equal(options?.cache, "no-store");
  assert.equal(new Headers(options?.headers).get("accept-language"), "es");
  assert.equal(
    new Headers(options?.headers).get("content-type"),
    "application/json",
  );
});
test("API client preserves rejection details without retrying a mutation", async (context) => {
  const fetch = context.mock.method(globalThis, "fetch", async () =>
    Response.json(
      {
        error: { code: "CONFLICT", message: "La reserva no se ha cambiado." },
        requestId: "test-request",
      },
      { status: 409 },
    ),
  );
  await assert.rejects(
    api("/api/example", { method: "POST", body: "{}" }),
    (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 409);
      assert.equal(error.code, "CONFLICT");
      assert.equal(error.message, "La reserva no se ha cambiado.");
      assert.equal(error.requestId, "test-request");
      return true;
    },
  );
  assert.equal(fetch.mock.callCount(), 1);
});
test("API client accepts successful responses without a body", async (context) => {
  context.mock.method(
    globalThis,
    "fetch",
    async () => new Response(null, { status: 204 }),
  );
  assert.equal(await api("/api/example", { method: "DELETE" }), undefined);
});
