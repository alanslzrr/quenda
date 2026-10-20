import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../../src/app.ts";
import { verifyProductResponses } from "../helpers/response-contract.ts";

test("response verifier checks enums and formats, not just serializer output", async () => {
  const app = await buildApp({
    logLevel: "silent",
    database: { check: async () => {}, close: async () => {} },
  });
  const contracts = verifyProductResponses(app);
  let value = { state: "READY", date: "2030-01-01" };
  app.get(
    "/probe",
    {
      schema: {
        response: {
          200: {
            type: "object",
            required: ["state", "date"],
            properties: {
              state: { type: "string", enum: ["READY"] },
              date: { type: "string", format: "date" },
            },
          },
        },
      },
    },
    async () => value,
  );
  try {
    assert.equal((await app.inject("/probe")).statusCode, 200);
    assert.ok(contracts.successes.has("get /probe"));
    value = { state: "INVALID", date: "2030-01-01" };
    assert.equal((await app.inject("/probe")).statusCode, 500);
    value = { state: "READY", date: "not-a-date" };
    assert.equal((await app.inject("/probe")).statusCode, 500);
    assert.equal(contracts.failures.length, 2);
    assert.throws(() => contracts.assertValid());
  } finally {
    await app.close();
  }
});

test("authentication verifier retains invalid JSON responses without accepting an error fallback", async () => {
  const { verifyAuthenticationResponses } = await import(
    "../helpers/auth-response-contract.ts"
  );
  const app = await buildApp({
    logLevel: "silent",
    database: { check: async () => {}, close: async () => {} },
  });
  const contract = verifyAuthenticationResponses(app, {
    openapi: "3.1.1",
    paths: {
      "/probe": {
        get: {
          responses: {
            "200": {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["token"],
                    properties: { token: { type: "string" } },
                  },
                },
              },
            },
            "500": {
              content: { "application/json": { schema: { type: "object" } } },
            },
          },
        },
      },
    },
  });
  app.get("/api/auth/probe", async () => ({ wrong: true }));
  try {
    assert.equal((await app.inject("/api/auth/probe")).statusCode, 500);
    assert.equal(contract.failures.length, 1);
    assert.throws(() => contract.assertValid());
  } finally {
    await app.close();
  }
});
