import assert from "node:assert/strict";
import test from "node:test";
import { Ajv } from "ajv";
import addFormats from "ajv-formats";
import { Pool } from "pg";
import { buildApp } from "../../src/app.ts";

const unavailable = async (): Promise<never> => {
  throw new Error("Synthetic adapter failure; not a public message");
};

test("all product operations declare shared failures, unique IDs and complete path parameters", async () => {
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
  try {
    await app.ready();
    const spec = app.swagger();
    const checkReferences = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        if (key === "$ref") {
          assert.equal(typeof child, "string");
          assert.ok(child.startsWith("#/"), "contract must be self-contained");
          let target: unknown = spec;
          for (const part of child.slice(2).split("/")) {
            assert.ok(target && typeof target === "object", child);
            target = (target as Record<string, unknown>)[
              part.replaceAll("~1", "/").replaceAll("~0", "~")
            ];
          }
          assert.notEqual(target, undefined, child);
        } else checkReferences(child);
      }
    };
    checkReferences(spec);
    const validator = new Ajv({ strict: false, allErrors: true });
    addFormats.default(validator);
    validator.addSchema({ ...spec, $id: "urn:quenda:examples" });
    let examples = 0;
    const validateExamples = (value: unknown, pointer = ""): void => {
      if (!value || typeof value !== "object") return;
      const object = value as Record<string, unknown>;
      if (
        "example" in object &&
        ("type" in object || "$ref" in object || "schema" in object)
      ) {
        const check = validator.compile({
          $ref: `urn:quenda:examples#${pointer}${"schema" in object ? "/schema" : ""}`,
        });
        assert.ok(
          check(object.example),
          `${pointer}: ${validator.errorsText(check.errors)}`,
        );
        examples++;
      }
      for (const [key, child] of Object.entries(object)) {
        if (key === "example") continue;
        validateExamples(
          child,
          `${pointer}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`,
        );
      }
    };
    validateExamples(spec);
    assert.ok(
      examples >= 4,
      "reservation commands and shared error have validated examples",
    );
    const ids = new Set<string>();
    let operations = 0;
    for (const [path, item] of Object.entries(spec.paths ?? {})) {
      for (const method of ["get", "post", "put", "patch", "delete"] as const) {
        const operation = item[method];
        if (!operation) continue;
        operations++;
        assert.ok(operation.operationId, `${method} ${path}`);
        assert.ok(!ids.has(operation.operationId), operation.operationId);
        ids.add(operation.operationId);
        for (const status of [400, 413, 415, 500, 503]) {
          const response = operation.responses[String(status)];
          assert.ok(
            response && "content" in response,
            `${method} ${path}: ${status}`,
          );
          assert.ok(response.content?.["application/json"]?.schema);
        }
        const declared: { in?: string; name?: string; required?: boolean }[] =
          operation.parameters ?? [];
        const parameters = declared.filter(
          (parameter) => "in" in parameter && parameter.in === "path",
        );
        const names = parameters.map((parameter) => {
          assert.ok("name" in parameter);
          assert.equal(parameter.required, true);
          return parameter.name;
        });
        assert.deepEqual(
          names.sort(),
          [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]).sort(),
          `${method} ${path}`,
        );
      }
    }
    assert.ok(
      operations > 60,
      "must register all product modules, not just health routes",
    );
    const url = "/api/municipalities";
    for (const [contentType, payload, status, code] of [
      ["application/json", "{", 400, "INVALID_INPUT"],
      [
        "application/json",
        JSON.stringify({ name: "x".repeat(1048576) }),
        413,
        "PAYLOAD_TOO_LARGE",
      ],
      ["application/xml", "<municipality />", 415, "UNSUPPORTED_MEDIA_TYPE"],
    ] as const) {
      const response = await app.inject({
        method: "POST",
        url,
        payload,
        headers: { "content-type": contentType, "accept-language": "gl" },
      });
      assert.equal(response.statusCode, status);
      assert.equal(response.json().error.code, code);
      assert.equal(response.json().requestId, response.headers["x-request-id"]);
      assert.equal(response.headers["content-language"], "gl");
      assert.ok(spec.paths?.[url]?.post?.responses[String(status)]);
    }
    const failedAuth = await app.inject("/api/me");
    assert.equal(failedAuth.statusCode, 500);
    assert.equal(failedAuth.json().error.code, "INTERNAL_ERROR");
    assert.ok(!failedAuth.body.includes("Synthetic"));
    assert.ok(spec.paths?.["/api/me"]?.get?.responses["500"]);
    const readiness = await app.inject("/health/ready");
    assert.equal(readiness.statusCode, 503);
    assert.equal(readiness.json().error.code, "UNAVAILABLE");
  } finally {
    await app.close();
  }
});
