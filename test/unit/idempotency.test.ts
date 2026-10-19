import assert from "node:assert/strict";
import test from "node:test";
import { commandFingerprint } from "../../src/database/idempotency.ts";

test("command fingerprints normalize object order but preserve values and array order", () => {
  assert.equal(
    commandFingerprint({ b: [{ y: 2, x: 1 }], a: null }),
    commandFingerprint({ a: null, b: [{ x: 1, y: 2 }] }),
  );
  assert.notEqual(commandFingerprint([1, 2]), commandFingerprint([2, 1]));
  assert.notEqual(
    commandFingerprint({ revision: 1 }),
    commandFingerprint({ revision: 2 }),
  );
  assert.notEqual(
    commandFingerprint({ value: null }),
    commandFingerprint({ value: "null" }),
  );
  assert.notEqual(
    commandFingerprint({ value: 1 }),
    commandFingerprint({ value: "1" }),
  );
  assert.throws(() => commandFingerprint({ value: Number.NaN }), {
    code: "INVALID_INPUT",
  });
  assert.throws(() => commandFingerprint({ value: Infinity }), {
    code: "INVALID_INPUT",
  });
});
