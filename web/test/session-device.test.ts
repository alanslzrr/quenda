import assert from "node:assert/strict";
import test from "node:test";
import { sessionDevice } from "../src/features/account/session-device.ts";

test("session labels describe available browser information without inventing locations", () => {
  assert.equal(sessionDevice(null, "es"), "Navegador no identificado");
  assert.equal(
    sessionDevice("Mozilla/5.0 (Windows NT 10.0) Chrome/140.0 Edg/140.0", "es"),
    "Edge · Windows",
  );
  assert.equal(
    sessionDevice("Mozilla/5.0 (iPhone) Safari/605.1", "gl"),
    "Safari · iOS",
  );
  assert.equal(sessionDevice("unrecognized", "es"), "Navegador");
});
