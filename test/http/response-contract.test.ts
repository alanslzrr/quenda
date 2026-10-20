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
