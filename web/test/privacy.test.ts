import assert from "node:assert/strict";
import test from "node:test";
import {
  accountKeyedFamily,
  conflictReason,
  directoryAvailable,
  explicitPrivacy,
  families,
  period,
} from "../src/features/privacy/model.ts";

test("privacy permissions are independent and require explicit municipal scope", () => {
  assert.equal(explicitPrivacy([], "PRIVACY_READ"), false);
  assert.equal(
    explicitPrivacy(
      [{ operation: "PRIVACY_EXECUTE", unitId: null }],
      "PRIVACY_READ",
    ),
    false,
  );
  assert.equal(
    explicitPrivacy(
      [{ operation: "PRIVACY_READ", unitId: "unit" }],
      "PRIVACY_READ",
    ),
    false,
  );
  assert.equal(
    explicitPrivacy(
      [{ operation: "PRIVACY_READ", unitId: null }],
      "PRIVACY_READ",
    ),
    true,
  );
  assert.deepEqual(
    families
      .filter((f) => f.global)
      .map((f) => f.value)
      .sort(),
    ["AUTHENTICATION", "AUTHORITY", "IDENTITY"],
  );
  assert.equal(families.filter((f) => f.municipal).length, 5);
});
test("retention periods have no defaults and reject fractional or out-of-range values", () => {
  for (const input of [null, "", "0", "-1", "1.5", "365001", "invalid"])
    assert.throws(() => period(input));
  assert.equal(period("1"), 1);
  assert.equal(period("365000"), 365000);
});
test("privacy forms list linked people only where the actor already administers the municipality", () => {
  assert.equal(
    directoryAvailable({ global: false, administrator: true }),
    true,
  );
  // A privacy permission alone never opens the municipal directory.
  assert.equal(
    directoryAvailable({ global: false, administrator: false }),
    false,
  );
  assert.equal(
    directoryAvailable({ global: true, administrator: true }),
    false,
  );
  assert.deepEqual(families.map((f) => f.value).filter(accountKeyedFamily), [
    "MUNICIPAL_PROFILE",
    "AUTHORITY",
  ]);
});

test("retention conflict codes read as sentences in both languages", () => {
  assert.equal(
    conflictReason("LEGAL_HOLD", "es"),
    "Hay una excepción de conservación activa",
  );
  assert.equal(
    conflictReason("RETAINED_SERVICE_DEPENDENCIES", "gl"),
    "Datos do servizo que deben conservarse dependen deste rexistro",
  );
  assert.equal(conflictReason("SOMETHING_NEW", "es"), "SOMETHING_NEW");
  assert.equal(conflictReason("toString", "es"), "toString");
});
