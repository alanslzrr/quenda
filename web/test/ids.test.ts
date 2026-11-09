import assert from "node:assert/strict";
import test from "node:test";
import { hasInvalidIds, isUuid } from "../src/app/ids.ts";

const id = "00000000-0000-4000-8000-000000000001";

test("only canonical UUIDs are accepted as resource ids", () => {
  assert.equal(isUuid(id), true);
  assert.equal(isUuid(id.toUpperCase()), true);
  for (const value of [
    "",
    "../administracion",
    `${id}/x`,
    `${id}?a=b`,
    "-".repeat(36),
    "a".repeat(36),
    undefined,
  ])
    assert.equal(isUuid(value), false);
});

test("a route with any malformed *Id parameter is rejected before it can build an API path", () => {
  assert.equal(hasInvalidIds({ tenantId: id, unitId: id }), false);
  assert.equal(hasInvalidIds({ tenantId: id, section: "personal" }), false);
  assert.equal(hasInvalidIds({ version: "3", agreementId: id }), false);
  assert.equal(hasInvalidIds({ tenantId: "a/b" }), true);
  assert.equal(hasInvalidIds({ tenantId: id, reservationId: "x?y" }), true);
  assert.equal(hasInvalidIds({ "*": "anything" }), false);
});
