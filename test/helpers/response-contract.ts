import assert from "node:assert/strict";
import { Ajv, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import type { FastifyInstance } from "fastify";

// Test-only validation: response serialization alone does not enforce every
// JSON Schema constraint (for example enums and string formats).
export function verifyProductResponses(app: FastifyInstance) {
  const validator = new Ajv({ strict: false, allErrors: true });
  addFormats.default(validator);
  const compiled = new Map<string, ValidateFunction>();
  const successes = new Set<string>();
  const failures: string[] = [];
  let registered = false;
  app.addHook("onSend", async (request, reply, payload) => {
    if (!request.routeOptions.schema || request.routeOptions.schema.hide)
      return payload;
    try {
      if (!String(reply.getHeader("content-type")).includes("application/json"))
        return payload;
      assert.ok(
        typeof payload === "string",
        `${request.method} ${request.routeOptions.url} ${reply.statusCode}: payload ${typeof payload}`,
      );
      assert.ok(request.routeOptions.url);
      if (!registered) {
        validator.addSchema({ ...app.swagger(), $id: "urn:quenda:contract" });
        registered = true;
      }
      const path = request.routeOptions.url.replace(/:([^/]+)/g, "{$1}");
      const method = request.method.toLowerCase();
      const key = `${method} ${path} ${reply.statusCode}`;
      let check = compiled.get(key);
      if (!check) {
        const escaped = path.replaceAll("~", "~0").replaceAll("/", "~1");
        check = validator.compile({
          $ref: `urn:quenda:contract#/paths/${escaped}/${method}/responses/${reply.statusCode}/content/application~1json/schema`,
        });
        compiled.set(key, check);
      }
      assert.ok(
        check(JSON.parse(payload)),
        `${key}: ${validator.errorsText(check.errors)}`,
      );
      if (reply.statusCode < 300) successes.add(`${method} ${path}`);
      return payload;
    } catch (error) {
      failures.push(
        error instanceof Error ? error.message : "Contract validation failed",
      );
      throw error;
    }
  });
  return {
    successes,
    failures,
    assertValid: () => assert.deepEqual(failures, []),
  };
}
