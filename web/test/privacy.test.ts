import assert from "node:assert/strict";
import test from "node:test";
import {
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
