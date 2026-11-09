import assert from "node:assert/strict";
import test from "node:test";
import SwaggerParser from "@apidevtools/swagger-parser";
import { Pool } from "pg";
import { buildApp } from "../../src/app.ts";
import { operationSummary } from "../../src/http/openapi-summary.ts";

const unavailable = async (): Promise<never> => {
  throw new Error("Synthetic adapter failure; not a public message");
};
const methods = ["get", "post", "put", "patch", "delete"] as const;

async function contract() {
  const domain = new Pool();
  const app = await buildApp({
    logLevel: "silent",
    database: { check: unavailable, close: () => domain.end() },
    domain,
    identity: {
      config: {
        origin: "https://schema.invalid",
        secret: "contract-test-only",
      },
      authentication: {
        handler: unavailable,
        schema: unavailable,
        verifyDeactivation: unavailable,
        requestReactivation: unavailable,
        confirmReactivation: unavailable,
        requestEmailChange: unavailable,
        approveEmailChange: unavailable,
        confirmEmailChange: unavailable,
        authenticate: unavailable,
      },
    },
  });
  await app.ready();
  const spec = JSON.parse(JSON.stringify(app.swagger()));
  await app.close();
  return spec;
}

test("the generated contract is valid OpenAPI for a tool outside this repository", async () => {
  const spec = await contract();
  // A schema-level validation of the whole document, including every referenced component.
  await SwaggerParser.validate(structuredClone(spec));
  assert.ok(spec.servers?.length, "the contract declares where it is served");
});

test("every operation has a summary, a tag and a unique identifier, and no parameter is invented", async () => {
  const spec = await contract();
  const ids = new Set<string>();
  for (const [path, item] of Object.entries<Record<string, any>>(spec.paths))
    for (const method of methods) {
      const operation = item[method];
      if (!operation) continue;
      const label = `${method.toUpperCase()} ${path}`;
      assert.ok(operation.summary?.trim(), `${label} has no summary`);
      assert.ok(
        operation.summary.length <= 120,
        `${label} summary is too long`,
      );
      assert.ok(operation.tags?.length, `${label} has no tag`);
      assert.ok(operation.operationId, `${label} has no operationId`);
      assert.ok(
        Array.isArray(operation.security),
        `${label} does not declare its security`,
      );
      assert.ok(!ids.has(operation.operationId), `${label} repeats an id`);
      ids.add(operation.operationId);
      for (const parameter of operation.parameters ?? []) {
        assert.equal(
          typeof parameter.schema,
          "object",
          `${label}: ${parameter.name}`,
        );
        assert.ok(
          !["type", "additionalProperties", "properties", "required"].includes(
            parameter.name,
          ),
          `${label} exposes a schema keyword as parameter ${parameter.name}`,
        );
      }
    }
});

test("summaries come from the first sentence, are bounded and fall back to the operation id", () => {
  assert.equal(
    operationSummary({
      description:
        "Alta administrativa de una instalación en borrador. No la publica.",
    }),
    "Alta administrativa de una instalación en borrador",
  );
  assert.equal(
    operationSummary({ summary: "  Ya definido  ", description: "Otro." }),
    "Ya definido",
  );
  assert.equal(
    operationSummary({ operationId: "rename_facility" }),
    "Rename facility",
  );
  assert.equal(
    operationSummary({ operationId: "ownReservations" }),
    "Own reservations",
  );
  const long = operationSummary({
    description: `${"palabra ".repeat(40)}final.`,
  });
  assert.ok(long.length <= 100 && long.endsWith("…"), long);
});
