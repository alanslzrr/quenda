import assert from "node:assert/strict";
import test from "node:test";
import { normalizedAccountName } from "../../src/modules/identity/account-profile.ts";

test("account name editing accepts only a bounded name, never identity or security fields", () => {
  assert.equal(
    normalizedAccountName({ name: "  María Pérez  " }),
    "María Pérez",
  );
  assert.equal(
    normalizedAccountName({ name: "x".repeat(200) }),
    "x".repeat(200),
  );
  for (const value of [
    null,
    [],
    {},
    { name: null },
    { name: 7 },
    { name: "" },
    { name: "   " },
    { name: "x".repeat(201) },
    { name: "a\u0000b" },
    { name: "a\nb" },
    { name: "a\u007fb" },
    { name: "a", userId: "other" },
    { name: "a", emailVerified: true },
    { name: "a", mfaVerifiedAt: new Date() },
  ])
    assert.equal(normalizedAccountName(value), null);
});
