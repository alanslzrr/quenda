import assert from "node:assert/strict";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { FastifyInstance } from "fastify";

export function verifyAuthenticationResponses(
  app: FastifyInstance,
  schema: {
    openapi: string;
    paths: Record<string, unknown>;
    [key: string]: unknown;
  },
) {
  assert.equal(schema.openapi, "3.1.1");
  const validator = new Ajv2020({ strict: false, allErrors: true });
  addFormats.default(validator);
  validator.addSchema({ ...schema, $id: "urn:quenda:auth-contract" });
  const failures: string[] = [];
  const checked = new Set<string>();
  app.addHook("onSend", (request, reply, payload, done) => {
    const url = new URL(request.url, "https://quenda.test");
    if (!url.pathname.startsWith("/api/auth/")) return done(null, payload);
    if (reply.statusCode >= 300 && reply.statusCode < 400)
      return done(null, payload);
    const path = url.pathname.slice("/api/auth".length);
    // Schema delivery and redirects are not JSON authentication results.
    if (path === "/open-api/generate-schema" || !schema.paths[path])
      return done(null, payload);
    if (!String(reply.getHeader("content-type")).includes("application/json"))
      return done(null, payload);
    const method = request.method.toLowerCase();
    const key = `${method} ${path} ${reply.statusCode}`;
    try {
      assert.ok(
        typeof payload === "string",
        `${key}: payload ${typeof payload}`,
      );
      const escaped = path.replaceAll("~", "~0").replaceAll("/", "~1");
      const reference = `urn:quenda:auth-contract#/paths/${escaped}/${method}/responses/${reply.statusCode}/content/application~1json/schema`;
      const check =
        validator.getSchema(reference) ??
        validator.compile({ $ref: reference });
      assert.ok(
        check(JSON.parse(payload)),
        `${key}: ${validator.errorsText(check.errors)}`,
      );
      checked.add(key);
    } catch (error) {
      failures.push(
        error instanceof Error
          ? error.message
          : "Authentication contract failed",
      );
      return done(error as Error);
    }
    return done(null, payload);
  });
  return {
    checked,
    failures,
    assertValid: () => assert.deepEqual(failures, []),
  };
}
